import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchClicks, searchQueries } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { looksPersonal, normalizeText } from "./normalize";
import { queryRows } from "./sql";
import { analyticsWindow } from "./visitor";

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
    console.error("Could not record a search.", error);
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
    console.error("Could not record a search click.", error);
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
  top: {
    query: string;
    searches: number;
    visitors: number;
    averageResults: number;
    clicks: number;
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

  const top = await queryRows<{
    query: string;
    searches: number;
    visitors: number;
    average_results: number;
    clicks: number;
  }>(sql`
    select
      (array_agg(q.query order by q.created_at desc))[1] as query,
      count(*)::int as searches,
      count(distinct q.visitor_hash)::int as visitors,
      round(avg(q.results_count))::int as average_results,
      (
        select count(*)::int from search_clicks c
        where c.query_norm = q.query_norm and c.created_at > ${since}
      ) as clicks
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
    top: top.map((row) => ({
      query: row.query,
      searches: Number(row.searches),
      visitors: Number(row.visitors),
      averageResults: Number(row.average_results),
      clicks: Number(row.clicks),
    })),
    zeroResults: zeroResults.map((row) => ({
      query: row.query,
      searches: Number(row.searches),
      visitors: Number(row.visitors),
      lastSearchedAt: new Date(row.last_searched_at),
    })),
    missing: [
      "Search-to-order conversion — a search is counted without an account, so it cannot be joined to the order that may follow it.",
    ],
  };
}

/**
 * Deletes search analytics older than six months. Aggregate trends are what
 * the report needs; individual rows past that age only cost storage.
 */
export async function pruneSearchLogs(
  olderThanDays = 180,
): Promise<{ queries: number; clicks: number }> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const queries = await db
      .delete(searchQueries)
      .where(lt(searchQueries.createdAt, cutoff))
      .returning({ id: searchQueries.id });

    const clicks = await db
      .delete(searchClicks)
      .where(lt(searchClicks.createdAt, cutoff))
      .returning({ id: searchClicks.id });

    return { queries: queries.length, clicks: clicks.length };
  } catch (error) {
    console.error("Could not prune search analytics.", error);
    return { queries: 0, clicks: 0 };
  }
}
