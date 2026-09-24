import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchClicks, searchQueries } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { pruneSearchEvents } from "./events";
import { looksPersonal, normalizeText } from "./normalize";
import { queryRows } from "./sql";
import { analyticsWindow } from "./visitor";
import { logEvent } from "@/lib/observability/log";
import { pruneInBatches } from "@/lib/prune";

/**
 * What people search for, and what they do next.
 *
 * Recorded from real searches only, and read back only past a threshold. A
 * query is shown to other shoppers as "popular" or "trending" only once at
 * least three different visitors have searched it and it found something —
 * below that it is one person's search, not a trend, and showing it would be
 * both a fabrication and a small privacy leak (docs/SECURITY.md).
 *
 * Nothing here may break a search. Every write swallows its own failure: a
 * shopper who cannot be counted should still get their results.
 */

/** Below this many distinct visitors, a query is nobody's business but theirs. */
export const PUBLIC_QUERY_THRESHOLD = 3;

export async function logSearch(entry: {
  query: string;
  resultsCount: number;
  correctedQuery: string | null;
  visitorHash: string;
  now?: Date;
}): Promise<void> {
  const normalized = normalizeText(entry.query);
  if (!normalized || looksPersonal(entry.query)) return;

  const now = entry.now ?? new Date();

  try {
    await db
      .insert(searchQueries)
      .values({
        query: entry.query.slice(0, 100),
        queryNorm: normalized,
        resultsCount: entry.resultsCount,
        correctedQuery: entry.correctedQuery,
        visitorHash: entry.visitorHash,
        windowStart: analyticsWindow(now),
        createdAt: now,
      })
      // Paging, sorting and refreshing are not new searches.
      .onConflictDoNothing();
  } catch (error) {
    await logEvent("warn", "search.log_failed", { error });
  }
}

export async function logSearchClick(entry: {
  query: string;
  productId: string;
  position?: number;
  visitorHash: string;
  now?: Date;
}): Promise<void> {
  const normalized = normalizeText(entry.query);
  if (!normalized || looksPersonal(entry.query)) return;

  const now = entry.now ?? new Date();

  try {
    await db
      .insert(searchClicks)
      .values({
        queryNorm: normalized,
        productId: entry.productId,
        position: entry.position ?? null,
        visitorHash: entry.visitorHash,
        windowStart: analyticsWindow(now),
        createdAt: now,
      })
      .onConflictDoNothing();
  } catch (error) {
    // A product id that does not exist fails the foreign key; that is a
    // forged beacon, not something to report.
    await logEvent("warn", "search.click_log_failed", { error });
  }
}

/**
 * The searches most people ran in the last month that found something — in
 * the words the most recent of them typed, so the casing is theirs.
 */
export async function popularSearches(
  options: { limit?: number; days?: number; prefix?: string } = {},
): Promise<string[]> {
  const limit = options.limit ?? 6;
  const days = options.days ?? 30;
  const prefix = options.prefix ? normalizeText(options.prefix) : "";

  const rows = await queryRows<{ label: string }>(sql`
    select (array_agg(q.query order by q.created_at desc))[1] as label
    from search_queries q
    where q.created_at > now() - make_interval(days => ${days})
      and q.results_count > 0
      ${prefix ? sql`and q.query_norm like ${`${prefix}%`} and q.query_norm <> ${prefix}` : sql``}
    group by q.query_norm
    having count(distinct q.visitor_hash) >= ${PUBLIC_QUERY_THRESHOLD}
    order by count(distinct q.visitor_hash) desc, max(q.created_at) desc
    limit ${limit}
  `);

  return rows.map((row) => row.label);
}

/**
 * Searches climbing this week: at least the public threshold of visitors in
 * the last seven days, and at least twice as many as the seven before.
 */
export async function trendingSearches(limit = 5): Promise<string[]> {
  const rows = await queryRows<{ label: string }>(sql`
    select (array_agg(q.query order by q.created_at desc))[1] as label
    from search_queries q
    where q.created_at > now() - interval '14 days'
      and q.results_count > 0
    group by q.query_norm
    having
      count(distinct q.visitor_hash) filter (where q.created_at > now() - interval '7 days')
        >= ${PUBLIC_QUERY_THRESHOLD}
      and count(distinct q.visitor_hash) filter (where q.created_at > now() - interval '7 days')
        >= 2 * count(distinct q.visitor_hash) filter (where q.created_at <= now() - interval '7 days')
    order by count(distinct q.visitor_hash) filter (where q.created_at > now() - interval '7 days') desc
    limit ${limit}
  `);

  return rows.map((row) => row.label);
}

export type SearchReport = {
  days: number;
  searches: number;
  visitors: number;
  zeroResultSearches: number;
  /** Searches followed by a click on a result, as a share of searches. */
  clickThroughRate: number | null;
  /** Searches on which a filter was then used, as a share of searches. */
  filterRate: number | null;
  /** Searches the same visitor rephrased shortly after, as a share. */
  refinementRate: number | null;
  /** Searches followed by that result going into a cart. */
  addToCartSearches: number;
  /** Searches followed by a confirmed payment for what they found. */
  convertedSearches: number;
  /** Units bought through a search, on orders whose payment was confirmed. */
  convertedUnits: number;
  top: {
    query: string;
    searches: number;
    visitors: number;
    averageResults: number;
    clicks: number;
    addToCarts: number;
    purchases: number;
  }[];
  zeroResults: {
    query: string;
    searches: number;
    visitors: number;
    lastSearchedAt: Date;
  }[];
  /** What cannot be measured from what is recorded, said out loud. */
  missing: string[];
};

/**
 * The search report on the admin page. Staff only: the queries themselves are
 * shown in full here, including ones below the public threshold, because the
 * point is to see what people could not find.
 */
export async function searchReport(
  actor: SessionUser | null,
  days = 30,
): Promise<SearchReport> {
  requirePermission(actor, "search.manage");

  const since = sql`now() - make_interval(days => ${days})`;

  const [totals] = await queryRows<{
    searches: number;
    visitors: number;
    zero: number;
    pairs: number;
    clicked: number;
  }>(sql`
    select
      (select count(*)::int from search_queries where created_at > ${since}) as searches,
      (select count(distinct visitor_hash)::int from search_queries where created_at > ${since}) as visitors,
      (select count(*)::int from search_queries where created_at > ${since} and results_count = 0) as zero,
      (select count(*)::int from (
        select distinct visitor_hash, query_norm from search_queries where created_at > ${since}
      ) s) as pairs,
      (select count(*)::int from (
        select distinct q.visitor_hash, q.query_norm
        from search_queries q
        where q.created_at > ${since}
          and exists (
            select 1 from search_clicks c
            where c.visitor_hash = q.visitor_hash
              and c.query_norm = q.query_norm
              and c.created_at >= q.created_at
          )
      ) s) as clicked
  `);

  // What people did with their searches, from the first-party events (D-093).
  const [behaviour] = await queryRows<{
    filtered: number;
    refined: number;
    carted: number;
    converted: number;
    units: number;
  }>(sql`
    select
      (select count(distinct (visitor_hash, query_norm))::int from search_events
        where event_type = 'filter' and created_at > ${since}) as filtered,
      (select count(distinct (visitor_hash, query_norm))::int from search_events
        where event_type = 'refine' and created_at > ${since}) as refined,
      (select count(distinct (visitor_hash, query_norm))::int from search_events
        where event_type = 'add_to_cart' and created_at > ${since}) as carted,
      (select count(*)::int from search_events
        where event_type = 'purchase' and created_at > ${since}) as converted,
      (select coalesce(sum(units), 0)::int from search_events
        where event_type = 'purchase' and created_at > ${since}) as units
  `);

  const top = await queryRows<{
    query: string;
    searches: number;
    visitors: number;
    average_results: number;
    clicks: number;
    add_to_carts: number;
    purchases: number;
  }>(sql`
    select
      (array_agg(q.query order by q.created_at desc))[1] as query,
      count(*)::int as searches,
      count(distinct q.visitor_hash)::int as visitors,
      round(avg(q.results_count))::int as average_results,
      (
        select count(*)::int from search_clicks c
        where c.query_norm = q.query_norm and c.created_at > ${since}
      ) as clicks,
      (
        select count(*)::int from search_events e
        where e.query_norm = q.query_norm and e.event_type = 'add_to_cart'
          and e.created_at > ${since}
      ) as add_to_carts,
      (
        select coalesce(sum(e.units), 0)::int from search_events e
        where e.query_norm = q.query_norm and e.event_type = 'purchase'
          and e.created_at > ${since}
      ) as purchases
    from search_queries q
    where q.created_at > ${since}
    group by q.query_norm
    order by count(*) desc, max(q.created_at) desc
    limit 20
  `);

  const zeroResults = await queryRows<{
    query: string;
    searches: number;
    visitors: number;
    last_searched_at: Date;
  }>(sql`
    select
      (array_agg(q.query order by q.created_at desc))[1] as query,
      count(*)::int as searches,
      count(distinct q.visitor_hash)::int as visitors,
      max(q.created_at) as last_searched_at
    from search_queries q
    where q.created_at > ${since} and q.results_count = 0
    group by q.query_norm
    order by count(*) desc, max(q.created_at) desc
    limit 20
  `);

  const pairs = Number(totals?.pairs ?? 0);

  return {
    days,
    searches: Number(totals?.searches ?? 0),
    visitors: Number(totals?.visitors ?? 0),
    zeroResultSearches: Number(totals?.zero ?? 0),
    clickThroughRate: pairs === 0 ? null : Number(totals?.clicked ?? 0) / pairs,
    filterRate: pairs === 0 ? null : Number(behaviour?.filtered ?? 0) / pairs,
    refinementRate: pairs === 0 ? null : Number(behaviour?.refined ?? 0) / pairs,
    addToCartSearches: Number(behaviour?.carted ?? 0),
    convertedSearches: Number(behaviour?.converted ?? 0),
    convertedUnits: Number(behaviour?.units ?? 0),
    top: top.map((row) => ({
      query: row.query,
      searches: Number(row.searches),
      visitors: Number(row.visitors),
      averageResults: Number(row.average_results),
      clicks: Number(row.clicks),
      addToCarts: Number(row.add_to_carts),
      purchases: Number(row.purchases),
    })),
    zeroResults: zeroResults.map((row) => ({
      query: row.query,
      searches: Number(row.searches),
      visitors: Number(row.visitors),
      lastSearchedAt: new Date(row.last_searched_at),
    })),
    missing: [
      // Conversion is measured now, but only along the path it can honestly be
      // followed: opening a result, adding that product, paying for it. A
      // shopper who searches, leaves, and comes back tomorrow is not counted,
      // because there is nothing that could link the two without following
      // them — and an approximated figure would be worse than an absent one.
      "Conversion counts only searches whose result was opened and then bought within half an hour of the click. A search someone acts on later is not attributed to it.",
    ],
  };
}

/**
 * Deletes search analytics older than six months. Aggregate trends are what
 * the report needs; individual rows past that age only cost storage.
 */
export async function pruneSearchLogs(
  olderThanDays = 180,
): Promise<{ queries: number; clicks: number; events: number }> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    // Batched, because how much there is to delete is decided by traffic
    // rather than by the catalogue (D-111).
    const queries = await pruneInBatches(searchQueries, lt(searchQueries.createdAt, cutoff));
    const clicks = await pruneInBatches(searchClicks, lt(searchClicks.createdAt, cutoff));

    // Filters, refinements, carts and conversions age out on the same clock.
    const events = await pruneSearchEvents(olderThanDays);

    return { queries: queries.removed, clicks: clicks.removed, events };
  } catch (error) {
    await logEvent("warn", "search.prune_failed", { error });
    return { queries: 0, clicks: 0, events: 0 };
  }
}
