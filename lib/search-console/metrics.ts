import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, searchConsoleSyncState, searchConsoleSyncs } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { queryRows, type Executor } from "@/lib/pkb/common";
import { getSearchConsoleProvider } from "@/lib/providers/search-console";
import { addDays, daysBetween, getSearchConsoleConfig, isoDay } from "./config";

/**
 * Reading what Search Console reported.
 *
 * Every figure here is a sum over stored rows. Two rules hold throughout:
 *
 *  - An average position is weighted by impressions, because that is what the
 *    figure means; averaging the averages would let a page seen twice count as
 *    much as one seen ten thousand times.
 *  - A window says how many of its days actually have measurements. A caller
 *    that needs a complete window can see that it does not have one, which is
 *    what makes "not enough data" an answer rather than a silent zero.
 */

export type ConnectionState = "connected" | "not_configured" | "never_synced" | "sync_failed";

export type SearchConsoleStatus = {
  state: ConnectionState;
  /** Why, in words a person can act on. */
  message: string;
  property: string | null;
  /** The account the shop authenticates as. Never a credential. */
  account: string | null;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  syncedThrough: string | null;
  coverage: Coverage | null;
  lastSync: typeof searchConsoleSyncs.$inferSelect | null;
};

export type Coverage = {
  earliest: string | null;
  latest: string | null;
  /** Days that have at least one measurement. */
  daysWithData: number;
  rows: number;
};

export type Totals = {
  clicks: number;
  impressions: number;
  /** Derived from the two counts above, never stored separately. */
  ctr: number;
  /** Impression-weighted, as Search Console defines it. Null with no impressions. */
  position: number | null;
  daysWithData: number;
};

/**
 * What the measurement table costs to keep, for an operator (risk R-17).
 *
 * The table's size is driven by what Google reports rather than by the size of
 * the catalogue, and the sync deliberately stores rows for pages this shop no
 * longer has, so nobody can tell how large it is by looking at the catalogue.
 * Everything here is measured: the row counts are counted, the size comes from
 * PostgreSQL's own accounting of the table and its indexes, and the last prune
 * is the last `maintenance.prune` job that actually ran. Nothing is estimated
 * or projected forward.
 */
export type MetricsStorage = {
  rows: number;
  /** Every property with rows stored, including one no longer configured. */
  properties: { property: string; rows: number; earliest: string | null; latest: string | null }[];
  /** The table with its indexes and toast, as PostgreSQL reports it. */
  bytes: number | null;
  retentionDays: number;
  /** Days before this are deleted by the next prune. */
  prunesBefore: string;
  /** Rows the next prune will remove. Normally zero between syncs. */
  rowsOutsideRetention: number;
  lastPrune: { at: Date; removed: number | null } | null;
};

export type Window = { start: string; end: string };

export function windowEndingToday(days: number, today = isoDay(new Date())): Window {
  return { start: addDays(today, -(days - 1)), end: today };
}

export function windowLength(window: Window): number {
  return daysBetween(window.start, window.end) + 1;
}

/** The connection, the last sync and how much data is stored. */
export async function searchConsoleStatus(actor: SessionUser | null): Promise<SearchConsoleStatus> {
  requirePermission(actor, "seo.view");
  const provider = getSearchConsoleProvider();
  const connection = provider.connection();

  if (connection.status === "NOT_CONFIGURED") {
    return {
      state: "not_configured",
      message: connection.message,
      property: null,
      account: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      syncedThrough: null,
      coverage: null,
      lastSync: null,
    };
  }

  const [state] = await db
    .select()
    .from(searchConsoleSyncState)
    .where(eq(searchConsoleSyncState.property, connection.property));
  const [lastSync] = await db
    .select()
    .from(searchConsoleSyncs)
    .where(eq(searchConsoleSyncs.property, connection.property))
    .orderBy(desc(searchConsoleSyncs.createdAt))
    .limit(1);
  const coverage = await coverageFor(db, connection.property);

  const resolved: ConnectionState = !state?.lastSuccessAt
    ? state && state.lastStatus !== "never_run"
      ? "sync_failed"
      : "never_synced"
    : state.lastStatus === "ok"
      ? "connected"
      : "sync_failed";

  const message =
    resolved === "connected"
      ? `Connected to ${connection.property}.`
      : resolved === "never_synced"
        ? `Connected to ${connection.property}, but nothing has been synced yet.`
        : (state?.lastError ?? "The last sync did not finish.");

  return {
    state: resolved,
    message,
    property: connection.property,
    account: connection.account,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastError: state?.lastError ?? null,
    syncedThrough: state?.syncedThrough ?? null,
    coverage,
    lastSync: lastSync ?? null,
  };
}

/** The property this shop stores measurements under, or null when unconnected. */
export function configuredProperty(): string | null {
  const connection = getSearchConsoleProvider().connection();
  return connection.status === "CONFIGURED" ? connection.property : null;
}

export async function coverageFor(executor: Executor, property: string): Promise<Coverage> {
  const [row] = await queryRows<{ earliest: string | null; latest: string | null; days: number; rows: number }>(
    executor,
    sql`
      select
        min(measured_on)::text as earliest,
        max(measured_on)::text as latest,
        count(distinct measured_on)::int as days,
        count(*)::int as rows
      from search_console_metrics
      where property = ${property}
    `,
  );
  return {
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
    daysWithData: row?.days ?? 0,
    rows: row?.rows ?? 0,
  };
}

/**
 * How much is stored, over how long, and when it was last pruned (risk R-17).
 *
 * Deliberately independent of whether a provider is configured: rows outlive
 * the configuration that fetched them, and an operator asking "what is this
 * table costing me" needs an answer either way.
 */
export async function metricsStorage(
  actor: SessionUser | null,
  executor: Executor = db,
  now: Date = new Date(),
): Promise<MetricsStorage> {
  requirePermission(actor, "seo.view");
  const config = getSearchConsoleConfig();
  const prunesBefore = addDays(isoDay(now), -config.SEARCH_CONSOLE_RETENTION_DAYS);

  const [properties, [totals], [size], [prune]] = await Promise.all([
    queryRows<{ property: string; rows: number; earliest: string | null; latest: string | null }>(
      executor,
      sql`select property,
                 count(*)::int as rows,
                 min(measured_on)::text as earliest,
                 max(measured_on)::text as latest
          from search_console_metrics
          group by property
          order by count(*) desc`,
    ),
    queryRows<{ rows: number; outside: number }>(
      executor,
      sql`select count(*)::int as rows,
                 (count(*) filter (where measured_on < ${prunesBefore}::date))::int as outside
          from search_console_metrics`,
    ),
    // Null rather than a guess where the catalogue cannot be asked — PGlite
    // answers this, but a future executor might not.
    queryRows<{ bytes: string | null }>(
      executor,
      sql`select pg_total_relation_size('search_console_metrics')::text as bytes`,
    ).catch(() => [{ bytes: null }]),
    executor
      .select({ finishedAt: jobs.finishedAt, result: jobs.result })
      .from(jobs)
      .where(sql`${jobs.kind} = 'maintenance.prune' and ${jobs.finishedAt} is not null`)
      .orderBy(desc(jobs.finishedAt))
      .limit(1),
  ]);

  const removed = (prune?.result as { searchConsoleMetrics?: unknown } | null)?.searchConsoleMetrics;

  return {
    rows: Number(totals?.rows ?? 0),
    properties: properties.map((row) => ({ ...row, rows: Number(row.rows) })),
    bytes: size?.bytes == null ? null : Number(size.bytes),
    retentionDays: config.SEARCH_CONSOLE_RETENTION_DAYS,
    prunesBefore,
    rowsOutsideRetention: Number(totals?.outside ?? 0),
    lastPrune: prune?.finishedAt
      ? { at: prune.finishedAt, removed: typeof removed === "number" ? removed : null }
      : null,
  };
}

/** Site-wide totals for one window, from the page rows. */
export async function totalsFor(
  executor: Executor,
  property: string,
  window: Window,
  scope: { productId?: string; categoryId?: string } = {},
): Promise<Totals> {
  const [row] = await queryRows<{
    clicks: number;
    impressions: number;
    weighted: number | null;
    days: number;
  }>(
    executor,
    sql`
      select
        coalesce(sum(clicks), 0)::int as clicks,
        coalesce(sum(impressions), 0)::int as impressions,
        sum(position::float8 * impressions) as weighted,
        count(distinct measured_on)::int as days
      from search_console_metrics
      where property = ${property}
        and dimension = 'page'
        and measured_on between ${window.start}::date and ${window.end}::date
        ${scope.productId ? sql`and product_id = ${scope.productId}` : sql``}
        ${scope.categoryId ? sql`and category_id = ${scope.categoryId}` : sql``}
    `,
  );
  const clicks = row?.clicks ?? 0;
  const impressions = row?.impressions ?? 0;
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 && row?.weighted != null ? row.weighted / impressions : null,
    daysWithData: row?.days ?? 0,
  };
}

/**
 * How many pages, or page-and-search rows, a window actually holds above a
 * threshold (risk R-16).
 *
 * The opportunity engine reads a bounded number of rows. Without this it could
 * not tell the difference between "these are all the pages" and "these are the
 * first five hundred of four thousand", and a truncated report that looks
 * complete is worse than one that says it is partial.
 */
export async function performanceRowCount(
  executor: Executor,
  property: string,
  window: Window,
  options: { dimension?: "page" | "query" | "page_query"; minImpressions?: number } = {},
): Promise<number> {
  const dimension = options.dimension ?? "page";
  const groupBy =
    dimension === "page" ? sql`page_path` : dimension === "query" ? sql`query` : sql`page_path, query`;
  const [row] = await queryRows<{ n: number }>(
    executor,
    sql`
      select count(*)::int as n from (
        select 1
        from search_console_metrics
        where property = ${property}
          and dimension = ${dimension}
          and measured_on between ${window.start}::date and ${window.end}::date
        group by ${groupBy}
        having sum(impressions) >= ${options.minImpressions ?? 0}
      ) as grouped
    `,
  );
  return Number(row?.n ?? 0);
}

export type PagePerformance = {
  pagePath: string;
  productId: string | null;
  categoryId: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  daysWithData: number;
};

/**
 * One row per page in the window, worst CTR last — the opportunity engine's input.
 *
 * This is the engine's most expensive read, so two details in the aggregate are
 * deliberate (measured at 20,000 pages; see scripts/perf/search-console-bench.ts):
 *
 *  - `position` is `numeric`, and multiplying it per row costs more than the
 *    scan does. The weighted average only ever becomes a JavaScript number, so
 *    the multiplication is done in `float8` — 896 ms to 154 ms on its own.
 *  - `days` counts rows rather than distinct dates. A per-group
 *    `count(distinct …)` cannot be aggregated in parallel and sorts each group,
 *    which cost about 1.4 seconds here. It is safe because a page row carries
 *    no query (`sync.ts` stores `''` for `dimension = 'page'`) and
 *    `search_console_metrics_unique` covers
 *    (property, measured_on, dimension, page_path, query), so a page has at
 *    most one row per day. `tests/search-console-metrics.test.ts` asserts that.
 */
export async function pagePerformance(
  executor: Executor,
  property: string,
  window: Window,
  options: { minImpressions?: number; limit?: number } = {},
): Promise<PagePerformance[]> {
  const rows = await queryRows<{
    page_path: string;
    product_id: string | null;
    category_id: string | null;
    clicks: number;
    impressions: number;
    weighted: number;
    days: number;
  }>(
    executor,
    sql`
      select
        page_path,
        max(product_id::text) as product_id,
        max(category_id::text) as category_id,
        sum(clicks)::int as clicks,
        sum(impressions)::int as impressions,
        sum(position::float8 * impressions) as weighted,
        count(*)::int as days
      from search_console_metrics
      where property = ${property}
        and dimension = 'page'
        and measured_on between ${window.start}::date and ${window.end}::date
      group by page_path
      having sum(impressions) >= ${options.minImpressions ?? 0}
      order by sum(impressions) desc
      limit ${options.limit ?? 500}
    `,
  );
  return rows.map((row) => ({
    pagePath: row.page_path,
    productId: row.product_id,
    categoryId: row.category_id,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
    position: row.impressions > 0 ? row.weighted / row.impressions : 0,
    daysWithData: row.days,
  }));
}

export type QueryPerformance = {
  query: string;
  queryKey: string;
  pagePath: string | null;
  productId: string | null;
  categoryId: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** Queries attached to a page, or to the site when no page is named. */
export async function queryPerformance(
  executor: Executor,
  property: string,
  window: Window,
  options: {
    pagePath?: string;
    productId?: string;
    /** Which stored shape to read; page-and-query by default when a page is named. */
    dimension?: "query" | "page_query";
    minImpressions?: number;
    limit?: number;
  } = {},
): Promise<QueryPerformance[]> {
  const dimension = options.dimension ?? (options.pagePath || options.productId ? "page_query" : "query");
  const rows = await queryRows<{
    query: string;
    query_key: string;
    page_path: string;
    product_id: string | null;
    category_id: string | null;
    clicks: number;
    impressions: number;
    weighted: number;
  }>(
    executor,
    sql`
      select
        query,
        query_key,
        page_path,
        max(product_id::text) as product_id,
        max(category_id::text) as category_id,
        sum(clicks)::int as clicks,
        sum(impressions)::int as impressions,
        sum(position::float8 * impressions) as weighted
      from search_console_metrics
      where property = ${property}
        and dimension = ${dimension}
        and measured_on between ${window.start}::date and ${window.end}::date
        ${options.pagePath ? sql`and page_path = ${options.pagePath}` : sql``}
        ${options.productId ? sql`and product_id = ${options.productId}` : sql``}
      group by query, query_key, page_path
      having sum(impressions) >= ${options.minImpressions ?? 0}
      order by sum(impressions) desc
      limit ${options.limit ?? 200}
    `,
  );
  return rows.map((row) => ({
    query: row.query,
    queryKey: row.query_key,
    pagePath: row.page_path || null,
    productId: row.product_id,
    categoryId: row.category_id,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
    position: row.impressions > 0 ? row.weighted / row.impressions : 0,
  }));
}

/** How many of a window's days have measurements stored. */
export async function daysWithData(executor: Executor, property: string, window: Window): Promise<number> {
  const [row] = await queryRows<{ days: number }>(
    executor,
    sql`
      select count(distinct measured_on)::int as days
      from search_console_metrics
      where property = ${property}
        and measured_on between ${window.start}::date and ${window.end}::date
    `,
  );
  return row?.days ?? 0;
}
