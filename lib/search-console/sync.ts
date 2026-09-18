import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  searchConsoleMetrics,
  searchConsoleSyncState,
  searchConsoleSyncs,
  type SearchConsoleDimension,
  type SearchConsoleProviderState,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { enqueueJob } from "@/lib/jobs/runner";
import { logEvent } from "@/lib/observability/log";
import type { Executor } from "@/lib/pkb/common";
import { getSearchConsoleProvider, type SearchConsoleRow } from "@/lib/providers/search-console";
import { termKey } from "@/lib/search/terms";
import { addDays, daysBetween, getSearchConsoleConfig, isoDay } from "./config";
import { isOwnAddress, pathOf, resolvePaths } from "./paths";

/**
 * Bringing Search Console measurements into the shop (D-096).
 *
 * The shape of the job is the one the rest of Manifest already uses: a
 * requested row, a durable job, and a handler that can be retried freely. What
 * makes retrying safe here is the storage rule — a measurement is identified
 * by property, day, dimension, page and query, and storing it is an upsert on
 * exactly that key. So the same day can be fetched any number of times and
 * still be one row, which is what lets every sync deliberately re-read the
 * most recent days: Search Console revises them after first reporting them.
 *
 * Nothing here retries inside itself. A failed sync is a failed job, and the
 * job runner already knows how to retry a job.
 */

export class SearchConsoleError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SearchConsoleError";
    this.status = status;
  }
}

const DIMENSIONS: SearchConsoleDimension[] = ["page", "query", "page_query"];
/** Rows written per statement. Large enough to be few round trips, small enough to read. */
const WRITE_BATCH = 400;

export type SyncRow = typeof searchConsoleSyncs.$inferSelect;

export type SyncReport = {
  syncId: string;
  status: SyncRow["status"];
  providerState: SearchConsoleProviderState | null;
  property: string;
  windowStart: string;
  windowEnd: string;
  requestsMade: number;
  rowsFetched: number;
  rowsWritten: number;
  rowsUnchanged: number;
  daysCovered: number;
  message: string | null;
  error: string | null;
};

function reportOf(row: SyncRow): SyncReport {
  return {
    syncId: row.id,
    status: row.status,
    providerState: row.providerState,
    property: row.property,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    requestsMade: row.requestsMade,
    rowsFetched: row.rowsFetched,
    rowsWritten: row.rowsWritten,
    rowsUnchanged: row.rowsUnchanged,
    daysCovered: row.daysCovered,
    message: row.message,
    error: row.error,
  };
}

/**
 * The window this sync should ask for: from the watermark less the refresh
 * window, or a first backfill when there is no watermark, and never past the
 * most recent day Search Console has settled figures for.
 */
export function syncWindow(
  syncedThrough: string | null,
  today: string,
  config = getSearchConsoleConfig(),
): { start: string; end: string } | null {
  const end = addDays(today, -config.SEARCH_CONSOLE_LAG_DAYS);
  const earliest = addDays(end, -(config.SEARCH_CONSOLE_BACKFILL_DAYS - 1));
  const start = syncedThrough
    ? // Re-read the trailing days on top of the watermark, because the most
      // recent ones are revised after they are first reported.
      maxDay(addDays(syncedThrough, -(config.SEARCH_CONSOLE_REFRESH_DAYS - 1)), earliest)
    : earliest;
  if (daysBetween(start, end) < 0) return null;
  return { start, end };
}

function maxDay(a: string, b: string): string {
  return daysBetween(a, b) > 0 ? b : a;
}

function requestKeyFor(property: string, start: string, end: string, trigger: string, bucket: string): string {
  return createHash("sha256").update([property, start, end, trigger, bucket].join("|")).digest("hex").slice(0, 48);
}

async function loadState(executor: Executor, property: string) {
  const [row] = await executor.select().from(searchConsoleSyncState).where(eq(searchConsoleSyncState.property, property));
  return (row ?? null) as typeof searchConsoleSyncState.$inferSelect | null;
}

/**
 * Asks for a sync. The work runs in a job, never on the request: a backfill is
 * dozens of provider calls. Two requests for the same window inside one bucket
 * are one sync, so a double click, a retried POST and an overlapping scheduled
 * run cannot each start one.
 */
export async function requestSearchConsoleSync(
  actor: SessionUser | null,
  input: { trigger?: "manual" | "scheduled"; now?: Date } = {},
): Promise<SyncReport & { alreadyQueued: boolean }> {
  const trigger = input.trigger ?? "manual";
  const staff = trigger === "manual" ? requirePermission(actor, "catalog.manage") : null;
  const provider = getSearchConsoleProvider();
  const connection = provider.connection();
  const now = input.now ?? new Date();
  const today = isoDay(now);

  if (connection.status === "NOT_CONFIGURED") {
    // Not an error in the shop's terms — it is expected to run without Search
    // Console — but there is nothing to sync, and nothing is recorded: an
    // unconfigured property has no state worth keeping a row for.
    throw new SearchConsoleError(connection.message, 409);
  }

  const property = connection.property;
  const state = await loadState(db, property);
  const window = syncWindow(state?.syncedThrough ?? null, today);
  if (!window) {
    throw new SearchConsoleError("Search Console has nothing newer to report yet.", 409);
  }

  // One sync per minute for a manual request, one per hour for the schedule.
  const bucket = trigger === "manual" ? now.toISOString().slice(0, 16) : now.toISOString().slice(0, 13);
  const requestKey = requestKeyFor(property, window.start, window.end, trigger, bucket);

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(searchConsoleSyncs).where(eq(searchConsoleSyncs.requestKey, requestKey));
    if (existing) return { ...reportOf(existing), alreadyQueued: true };

    const [sync] = await tx
      .insert(searchConsoleSyncs)
      .values({
        property,
        requestKey,
        status: "queued",
        trigger,
        requestedBy: staff?.id ?? null,
        windowStart: window.start,
        windowEnd: window.end,
        providerKey: provider.key,
      })
      .returning();

    await enqueueJob(
      { kind: "seo.search_console_sync", payload: { syncId: sync.id }, dedupeKey: `search_console:${sync.id}` },
      tx,
    );

    if (staff) {
      await recordAudit(
        {
          actorUserId: staff.id,
          action: "seo.search_console_synced",
          entityType: "search_console",
          entityId: sync.id,
          after: { property, windowStart: window.start, windowEnd: window.end, trigger },
        },
        tx,
      );
    }
    return { ...reportOf(sync), alreadyQueued: false };
  });
}

/**
 * The scheduled path. It must never throw when Search Console is not set up —
 * an unconfigured shop would otherwise fail a job every hour — so it reports
 * what it did and stops.
 */
export async function scheduledSearchConsoleSync(): Promise<{ started: boolean; reason: string }> {
  try {
    const result = await requestSearchConsoleSync(null, { trigger: "scheduled" });
    return { started: !result.alreadyQueued, reason: result.alreadyQueued ? "already queued" : "queued" };
  } catch (error) {
    if (error instanceof SearchConsoleError) return { started: false, reason: error.message };
    throw error;
  }
}

type PreparedRow = {
  dimension: SearchConsoleDimension;
  measuredOn: string;
  pagePath: string;
  query: string;
  queryKey: string;
  productId: string | null;
  categoryId: string | null;
  clicks: number;
  impressions: number;
  position: string;
};

/**
 * Turns what the provider returned into rows this shop can store: addresses
 * become paths on this site, queries carry their comparison form, and anything
 * that does not belong to this property is dropped rather than stored under a
 * path that means nothing.
 */
async function prepare(
  executor: Executor,
  dimension: SearchConsoleDimension,
  rows: SearchConsoleRow[],
): Promise<PreparedRow[]> {
  const paths = new Map<SearchConsoleRow, string>();
  for (const row of rows) {
    if (dimension === "query") continue;
    if (!row.page || !isOwnAddress(row.page)) continue;
    const path = pathOf(row.page);
    if (path) paths.set(row, path.slice(0, 1000));
  }
  const resolved = await resolvePaths(executor, [...new Set(paths.values())]);

  const prepared: PreparedRow[] = [];
  for (const row of rows) {
    const query = dimension === "page" ? "" : (row.query ?? "").trim().slice(0, 300);
    const pagePath = dimension === "query" ? "" : (paths.get(row) ?? "");
    if (dimension !== "page" && !query) continue;
    if (dimension !== "query" && !pagePath) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;

    const entity = pagePath ? resolved.get(pagePath) : undefined;
    prepared.push({
      dimension,
      measuredOn: row.date,
      pagePath,
      query,
      queryKey: query ? termKey(query) : "",
      productId: entity?.productId ?? null,
      categoryId: entity?.categoryId ?? null,
      clicks: Math.max(0, Math.round(row.clicks)),
      // A click Google counted without an impression would fail the check
      // constraint; the counts are kept consistent rather than refused.
      impressions: Math.max(Math.max(0, Math.round(row.impressions)), Math.max(0, Math.round(row.clicks))),
      position: (Number.isFinite(row.position) ? Math.max(0, row.position) : 0).toFixed(2),
    });
  }
  return prepared;
}

/**
 * Stores a batch. The conflict target is the natural key, so re-reading a day
 * updates its rows instead of adding more; the `setWhere` means a row whose
 * figures have not moved is not rewritten at all, which is how the sync can
 * report how much of what it fetched was actually new.
 */
async function store(
  executor: Executor,
  property: string,
  syncId: string,
  rows: PreparedRow[],
): Promise<{ written: number; unchanged: number }> {
  let written = 0;
  for (let index = 0; index < rows.length; index += WRITE_BATCH) {
    const batch = rows.slice(index, index + WRITE_BATCH);
    const changed = await executor
      .insert(searchConsoleMetrics)
      .values(
        batch.map((row) => ({
          property,
          measuredOn: row.measuredOn,
          dimension: row.dimension,
          pagePath: row.pagePath,
          query: row.query,
          queryKey: row.queryKey,
          productId: row.productId,
          categoryId: row.categoryId,
          clicks: row.clicks,
          impressions: row.impressions,
          position: row.position,
          lastSyncId: syncId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          searchConsoleMetrics.property,
          searchConsoleMetrics.measuredOn,
          searchConsoleMetrics.dimension,
          searchConsoleMetrics.pagePath,
          searchConsoleMetrics.query,
        ],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          position: sql`excluded.position`,
          queryKey: sql`excluded.query_key`,
          productId: sql`excluded.product_id`,
          categoryId: sql`excluded.category_id`,
          lastSyncId: sql`excluded.last_sync_id`,
          updatedAt: new Date(),
        },
        setWhere: sql`
          ${searchConsoleMetrics.clicks} is distinct from excluded.clicks
          or ${searchConsoleMetrics.impressions} is distinct from excluded.impressions
          or ${searchConsoleMetrics.position} is distinct from excluded.position
          or ${searchConsoleMetrics.productId} is distinct from excluded.product_id
          or ${searchConsoleMetrics.categoryId} is distinct from excluded.category_id
        `,
      })
      .returning({ id: searchConsoleMetrics.id });
    written += changed.length;
  }
  return { written, unchanged: rows.length - written };
}

/**
 * Runs one requested sync. Retrieval happens outside a transaction (it is slow
 * and must not hold locks); each page of rows is stored in its own
 * transaction, so a failure halfway leaves the days already stored intact and
 * the sync marked failed with the reason on it.
 */
export async function runSearchConsoleSync(syncId: string): Promise<SyncReport> {
  const [sync]: SyncRow[] = await db.select().from(searchConsoleSyncs).where(eq(searchConsoleSyncs.id, syncId));
  if (!sync) throw new SearchConsoleError("That sync does not exist.", 404);
  // A finished sync is returned unchanged: a retried job cannot fetch twice.
  if (sync.status === "completed" || sync.status === "skipped") return reportOf(sync);

  const config = getSearchConsoleConfig();
  const provider = getSearchConsoleProvider();
  const started = new Date();
  await db
    .update(searchConsoleSyncs)
    .set({ status: "running", startedAt: started })
    .where(and(eq(searchConsoleSyncs.id, syncId), eq(searchConsoleSyncs.status, "queued")));

  const finish = async (
    patch: Partial<typeof searchConsoleSyncs.$inferInsert>,
    stateStatus: "ok" | "not_configured" | "unavailable" | "failed",
    advanceWatermark: boolean,
  ): Promise<SyncReport> => {
    const now = new Date();
    const [row] = await db
      .update(searchConsoleSyncs)
      .set({ ...patch, finishedAt: now })
      .where(eq(searchConsoleSyncs.id, syncId))
      .returning();
    await db
      .insert(searchConsoleSyncState)
      .values({
        property: sync.property,
        providerKey: provider.key,
        lastAttemptAt: now,
        lastSuccessAt: stateStatus === "ok" ? now : null,
        lastStatus: stateStatus,
        lastError: (patch.error ?? patch.message ?? null) as string | null,
        syncedThrough: advanceWatermark ? sync.windowEnd : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: searchConsoleSyncState.property,
        set: {
          providerKey: provider.key,
          lastAttemptAt: now,
          ...(stateStatus === "ok" ? { lastSuccessAt: now } : {}),
          lastStatus: stateStatus,
          lastError: (patch.error ?? patch.message ?? null) as string | null,
          // The watermark only ever moves forward, and only after a sync that
          // actually stored the whole window it asked for.
          ...(advanceWatermark
            ? {
                syncedThrough: sql`greatest(coalesce(${searchConsoleSyncState.syncedThrough}, ${sync.windowEnd}::date), ${sync.windowEnd}::date)`,
              }
            : {}),
          updatedAt: now,
        },
      });
    return reportOf(row);
  };

  let requestsMade = 0;
  let rowsFetched = 0;
  let rowsWritten = 0;
  let rowsUnchanged = 0;

  for (const dimension of DIMENSIONS) {
    let startRow = 0;
    for (;;) {
      if (requestsMade >= config.SEARCH_CONSOLE_MAX_REQUESTS) {
        // A bounded sync: what was stored stays, and the watermark does not
        // move, so the next run resumes over the same window.
        return finish(
          {
            status: "completed",
            providerState: "OK",
            requestsMade,
            rowsFetched,
            rowsWritten,
            rowsUnchanged,
            daysCovered: daysBetween(sync.windowStart, sync.windowEnd) + 1,
            message: `Stopped at the ${config.SEARCH_CONSOLE_MAX_REQUESTS}-request ceiling for one sync. The next sync continues from the same window.`,
          },
          "ok",
          false,
        );
      }

      const result = await provider.fetchPerformance({
        property: sync.property,
        startDate: sync.windowStart,
        endDate: sync.windowEnd,
        dimension,
        rowLimit: config.SEARCH_CONSOLE_ROW_LIMIT,
        startRow,
      });
      requestsMade += 1;

      if (result.status === "NOT_CONFIGURED") {
        return finish(
          { status: "skipped", providerState: "NOT_CONFIGURED", requestsMade, message: result.message },
          "not_configured",
          false,
        );
      }
      if (result.status === "UNAVAILABLE") {
        await logEvent("warn", "search_console.unavailable", { syncId, dimension });
        return finish(
          { status: "failed", providerState: "UNAVAILABLE", requestsMade, rowsFetched, rowsWritten, rowsUnchanged, error: result.message },
          "unavailable",
          false,
        );
      }
      if (result.status === "FAILED") {
        return finish(
          { status: "failed", providerState: "FAILED", requestsMade, rowsFetched, rowsWritten, rowsUnchanged, error: result.message },
          "failed",
          false,
        );
      }

      rowsFetched += result.rows.length;
      if (result.rows.length > 0) {
        try {
          await db.transaction(async (tx) => {
            const prepared = await prepare(tx, dimension, result.rows);
            const stored = await store(tx, sync.property, syncId, prepared);
            rowsWritten += stored.written;
            rowsUnchanged += stored.unchanged;
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return finish(
            { status: "failed", providerState: "OK", requestsMade, rowsFetched, rowsWritten, rowsUnchanged, error: `Storing measurements failed: ${message}` },
            "failed",
            false,
          );
        }
      }

      if (!result.hasMore) break;
      startRow += config.SEARCH_CONSOLE_ROW_LIMIT;
    }
  }

  return finish(
    {
      status: "completed",
      providerState: "OK",
      requestsMade,
      rowsFetched,
      rowsWritten,
      rowsUnchanged,
      daysCovered: daysBetween(sync.windowStart, sync.windowEnd) + 1,
      message: null,
      error: null,
    },
    "ok",
    true,
  );
}

/** Deletes measurements older than the retention window (the maintenance job). */
export async function pruneSearchConsoleMetrics(now: Date = new Date()): Promise<number> {
  const config = getSearchConsoleConfig();
  const cutoff = addDays(isoDay(now), -config.SEARCH_CONSOLE_RETENTION_DAYS);
  const removed = await db
    .delete(searchConsoleMetrics)
    .where(sql`${searchConsoleMetrics.measuredOn} < ${cutoff}::date`)
    .returning({ id: searchConsoleMetrics.id });
  return removed.length;
}
