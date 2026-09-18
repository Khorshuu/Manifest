import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchConsoleSyncState, searchConsoleSyncs } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { queryRows, type Executor } from "@/lib/pkb/common";
import { getSearchConsoleProvider } from "@/lib/providers/search-console";
import { addDays, daysBetween, isoDay } from "./config";

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

export type Window = { start: string; end: string };

export function windowEndingToday(days: number, today = isoDay(new Date())): Window {
  return { start: addDays(today, -(days - 1)), end: today };
}

export function windowLength(window: Window): number {
  return daysBetween(window.start, window.end) + 1;
}

/** The connection, the last sync and how much data is stored. */
export async function searchConsoleStatus(actor: SessionUser | null): Promise<SearchConsoleStatus> {
  requirePermission(actor, "catalog.manage");
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
        sum(position * impressions)::float8 as weighted,
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

/** One row per page in the window, worst CTR last — the opportunity engine's input. */
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
        sum(position * impressions)::float8 as weighted,
        count(distinct measured_on)::int as days
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
        sum(position * impressions)::float8 as weighted
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
