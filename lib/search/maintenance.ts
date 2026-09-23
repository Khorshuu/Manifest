import { asc, count, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { productSearch, productSearchQueue, products } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { enqueueUniquePending } from "@/lib/jobs/runner";
import { logEvent } from "@/lib/observability/log";

/**
 * Keeping the index honest.
 *
 * In normal running there is nothing to do: the triggers in migration 0014
 * rebuild a product's index row at the commit of whatever changed it. This is
 * for the two cases they cannot cover by themselves — a rebuild that failed
 * (its product stays queued, and the scheduled sweep retries it), and a
 * change to how the index is built, after which every row wants rebuilding
 * (the button on the search admin page).
 */

const CHUNK = 200;

function uuidArray(ids: string[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Claims the oldest chunk of the queue and rebuilds it, in one transaction.
 *
 * The claim is `for update skip locked`, the same device the job runner uses,
 * so two workers draining at once take different listings rather than
 * rebuilding the same ones twice. Claiming and deleting in one transaction is
 * also what makes a crash safe: the rows are released still queued, and the
 * delete rather than an update is what keeps the deferred trigger from arming
 * itself again on the way out.
 *
 * `onClaim` is handed the listings this chunk took before any of the work is
 * attempted, so the caller can still name them when the transaction rolls back.
 */
async function refreshOldestChunk(onClaim: (ids: string[]) => void): Promise<number> {
  return db.transaction(async (tx) => {
    const queued = await tx
      .select({ productId: productSearchQueue.productId })
      .from(productSearchQueue)
      .orderBy(asc(productSearchQueue.queuedAt))
      .limit(CHUNK)
      .for("update", { skipLocked: true });

    const ids = queued.map((row) => row.productId);
    onClaim(ids);
    if (ids.length === 0) return 0;

    await tx.execute(sql`select refresh_product_search(${uuidArray(ids)})`);
    await tx.delete(productSearchQueue).where(inArray(productSearchQueue.productId, ids));
    return ids.length;
  });
}

/**
 * Rebuilds whatever is queued: a rebuild that failed, and the whole catalogue
 * after `rebuildSearchIndex` queued it (risk R-12).
 *
 * Bounded twice over — a row limit and a time budget — so one run cannot
 * outlive a serverless function, and it continues itself while it is making
 * progress rather than waiting for the next sweep. A run that rebuilt nothing
 * does *not* continue itself: a chunk that always fails would otherwise
 * re-enqueue for ever. The rows stay queued with a rising attempt count, the
 * failure is logged, and `searchIndexStatus().queued` shows the backlog, so a
 * stuck rebuild is visible rather than silent.
 */
export async function processSearchQueue(
  options: { limit?: number; budgetMs?: number; continueWhenMore?: boolean; jobId?: string } = {},
): Promise<{ rebuilt: number; failed: number; remaining: number; continued: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 500, CHUNK), 20_000);
  const budgetMs = Math.min(Math.max(options.budgetMs ?? 20_000, 1_000), 120_000);
  const deadline = Date.now() + budgetMs;

  let rebuilt = 0;
  let failed = 0;

  while (rebuilt + failed < limit && Date.now() < deadline) {
    let claimed: string[] = [];
    try {
      const done = await refreshOldestChunk((ids) => {
        claimed = ids;
      });
      if (done === 0) break;
      rebuilt += done;
    } catch (error) {
      failed += claimed.length;
      await logEvent("error", "search.reindex_retry_failed", { error, listings: claimed.length });
      if (claimed.length > 0) {
        await db
          .update(productSearchQueue)
          .set({ attempts: sql`${productSearchQueue.attempts} + 1` })
          .where(inArray(productSearchQueue.productId, claimed))
          .catch(() => undefined);
      }
      // A failing chunk would otherwise be claimed again on the next pass and
      // block everything behind it, so this run stops and the sweep retries.
      break;
    }
  }

  const [left] = await db.select({ value: count() }).from(productSearchQueue);
  const remaining = Number(left?.value ?? 0);

  let continued = false;
  if (remaining > 0 && rebuilt > 0 && (options.continueWhenMore ?? true)) {
    // `jobId` is this run's own row, which is `running` while it asks. Without
    // excluding it, a worker could never continue itself; without the rest of
    // the check, every worker would enqueue a successor and they would multiply.
    continued = await enqueueUniquePending({
      kind: "search.process_queue",
      excludeJobId: options.jobId,
    });
  }

  if (remaining > 0) {
    await logEvent("info", "search.reindex_progress", { rebuilt, failed, remaining, continued });
  }

  return { rebuilt, failed, remaining, continued };
}

/**
 * Queues every product for reindexing, and asks the queue worker to start.
 *
 * Staff only; audited. Before Stage 7 this rebuilt all 5,000 rows inline —
 * about 20 ms each, so around a hundred seconds in one request, which no
 * serverless platform will allow to finish and nothing could resume if it
 * failed half-way (risk R-12). It now does one bounded insert into the queue
 * the triggers already use and hands the work to `search.process_queue`, which
 * is chunked, retried and observable. Three properties come free from that:
 *
 *  - **Resumable.** The queue rows are the progress record. A worker that dies
 *    leaves the rest queued, and `searchIndexStatus().queued` says how many.
 *  - **Retry-safe.** The queue is keyed by product, so queueing twice queues
 *    once, and a failed chunk stays queued with its attempt count.
 *  - **Safe beside catalogue activity.** A listing changed while the rebuild is
 *    draining is queued again by its own trigger and rebuilt after the change,
 *    not before it.
 */
export async function rebuildSearchIndex(
  actor: SessionUser | null,
): Promise<{ products: number; queued: number }> {
  const staff = requirePermission(actor, "search.manage");

  const { queued, total } = await db.transaction(async (tx) => {
    const [counted] = await tx.select({ value: count() }).from(products);
    // One statement, whatever the catalogue's size. `on conflict do nothing`
    // keeps a listing already waiting where it is, with its queued_at and its
    // attempt count intact.
    // Queued as a rebuild, so the deferred trigger leaves these to the
    // background worker instead of rebuilding every row at this commit
    // (migration 0039). A listing already waiting for a *change* keeps that
    // source and is still rebuilt at its own commit.
    await tx.execute(sql`
      insert into product_search_queue (product_id, source)
      select id, 'rebuild' from products
      on conflict (product_id) do nothing
    `);
    const [after] = await tx.select({ value: count() }).from(productSearchQueue);
    return { queued: Number(after?.value ?? 0), total: Number(counted?.value ?? 0) };
  });

  // Start now rather than waiting for the ten-minute sweep. One worker is
  // enough however many times the button is pressed: they would all drain the
  // same queue, and two of them racing means two rebuilds of the same row.
  await enqueueUniquePending({ kind: "search.process_queue" });

  await recordAudit({
    actorUserId: staff.id,
    action: "search.reindexed",
    entityType: "search_index",
    entityId: "products",
    after: { products: total, queued },
  });

  await logEvent("info", "search.reindex_requested", { products: total, queued });

  return { products: total, queued };
}

export type SearchIndexStatus = {
  products: number;
  indexed: number;
  /** Products with no index row at all — should be zero. */
  missing: number;
  /** Rebuilds that failed and are waiting for the sweep. */
  queued: number;
  lastIndexedAt: Date | null;
};

export async function searchIndexStatus(
  actor: SessionUser | null,
): Promise<SearchIndexStatus> {
  requirePermission(actor, "search.manage");

  const [[totals], [indexed], [missing], [queued]] = await Promise.all([
    db.select({ value: count() }).from(products),
    db
      .select({ value: count(), last: max(productSearch.indexedAt) })
      .from(productSearch),
    db
      .select({ value: count() })
      .from(products)
      .leftJoin(productSearch, eq(productSearch.productId, products.id))
      .where(isNull(productSearch.productId)),
    db.select({ value: count() }).from(productSearchQueue),
  ]);

  return {
    products: Number(totals?.value ?? 0),
    indexed: Number(indexed?.value ?? 0),
    missing: Number(missing?.value ?? 0),
    queued: Number(queued?.value ?? 0),
    lastIndexedAt: indexed?.last ? new Date(indexed.last) : null,
  };
}
