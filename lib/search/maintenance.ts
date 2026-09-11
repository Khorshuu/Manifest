import { asc, count, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { productSearch, productSearchQueue, products } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

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

async function refresh(ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select refresh_product_search(${uuidArray(ids)})`);
    // Rows are deleted rather than updated, so the deferred trigger that
    // processes the queue is not armed again by this.
    await tx
      .delete(productSearchQueue)
      .where(inArray(productSearchQueue.productId, ids));
  });
}

/** Retries whatever a failed rebuild left queued. Called by the sweep. */
export async function processSearchQueue(
  limit = 500,
): Promise<{ rebuilt: number; failed: number }> {
  const queued = await db
    .select({ productId: productSearchQueue.productId })
    .from(productSearchQueue)
    .orderBy(asc(productSearchQueue.queuedAt))
    .limit(limit);

  let rebuilt = 0;
  let failed = 0;

  for (let start = 0; start < queued.length; start += CHUNK) {
    const ids = queued.slice(start, start + CHUNK).map((row) => row.productId);
    try {
      await refresh(ids);
      rebuilt += ids.length;
    } catch (error) {
      failed += ids.length;
      console.error("Search index retry failed.", error);
      await db
        .update(productSearchQueue)
        .set({ attempts: sql`${productSearchQueue.attempts} + 1` })
        .where(inArray(productSearchQueue.productId, ids))
        .catch(() => undefined);
    }
  }

  return { rebuilt, failed };
}

/** Rebuilds every product's index row. Staff only; audited. */
export async function rebuildSearchIndex(
  actor: SessionUser | null,
): Promise<{ products: number }> {
  const staff = requirePermission(actor, "search.manage");

  const rows = await db.select({ id: products.id }).from(products);
  const ids = rows.map((row) => row.id);

  for (let start = 0; start < ids.length; start += CHUNK) {
    await refresh(ids.slice(start, start + CHUNK));
  }

  await recordAudit({
    actorUserId: staff.id,
    action: "search.reindexed",
    entityType: "search_index",
    entityId: "products",
    after: { products: ids.length },
  });

  return { products: ids.length };
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
