import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { pkbAliases } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { queryRows, type Executor } from "@/lib/pkb/common";
import { labelKey } from "@/lib/pkb/normalize";
import { termKey } from "@/lib/search/terms";
import { configuredProperty, queryPerformance, type Window } from "./metrics";
import { opportunityReport, THRESHOLDS, type Opportunity } from "./opportunities";

/**
 * Controlled learning (D-100).
 *
 * Manifest gets better at recommending things by reading what it already
 * knows: approved knowledge, approved sources and aliases, decisions staff
 * made, its own internal search log, Search Console performance and the SEO
 * change history. It does not train on any of that, and nothing here changes
 * what the shop believes.
 *
 * The hard rule is at the boundary: **a Search Console query never becomes a
 * product fact, an alias, a piece of SEO copy or an attribute by itself.** It
 * can only produce a recommendation on a screen. Turning one into vocabulary
 * is the two-step path D-094 already established — a person creates a
 * *suggested* alias, and somebody with `search.manage` approves it — and
 * turning one into copy is a person editing the listing. What people type into
 * Google is evidence of what they want; it is not evidence of what a product
 * is.
 */

export const RECOMMENDATION_KINDS = [
  /** A phrase people search Google for that this shop has no approved alias for. */
  "alias_candidate",
  /** Wording a page could use, because people ask for it in words the page lacks. */
  "terminology",
  /** A page doing measurably better; the recommendation is to leave it alone. */
  "leave_alone",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export type LearningRecommendation = {
  kind: RecommendationKind;
  /** What it is about. */
  subject: string;
  productId: string | null;
  pagePath: string | null;
  /** The phrase this is about, where there is one. */
  phrase: string | null;
  phraseKey: string | null;
  /** What was measured. */
  evidence: Record<string, string | number | null>;
  /** What a person could do about it. */
  recommendation: string;
  /** The decision that has to happen before anything changes. */
  requiresReview: string;
};

export type LearningReport = {
  connected: boolean;
  window: Window | null;
  recommendations: LearningRecommendation[];
  /** What this will never do on its own, stated for the screen. */
  guardrails: string[];
};

const GUARDRAILS = [
  "A Search Console query never becomes a product fact, an attribute or an alias on its own.",
  "An alias needs a person to suggest it and a second person's approval before it changes search.",
  "SEO copy is never rewritten automatically; a recommendation is a sentence on a screen.",
  "Search Console figures are internal analytics: never exported, and never evidence for a product's specification.",
];

/** How often a phrase must appear before it is worth a person's attention. */
const MIN_QUERY_IMPRESSIONS = THRESHOLDS.MIN_QUERY_IMPRESSIONS;

/**
 * What the measurements suggest somebody should look at. Read-only: this
 * function writes nothing at all, by design.
 */
export async function learningSignals(
  actor: SessionUser | null,
  options: { windowDays?: number; executor?: Executor; limit?: number } = {},
): Promise<LearningReport> {
  requirePermission(actor, "seo.view");
  const executor = options.executor ?? db;
  const property = configuredProperty();
  if (!property) return { connected: false, window: null, recommendations: [], guardrails: GUARDRAILS };

  const report = await opportunityReport(actor, { windowDays: options.windowDays, executor });
  if (!report.window) return { connected: true, window: null, recommendations: [], guardrails: GUARDRAILS };

  const queries = await queryPerformance(executor, property, report.window, {
    // Only a phrase that lands on a page of this shop can be that page's
    // vocabulary, so the page-and-query rows are the ones that matter.
    dimension: "page_query",
    minImpressions: MIN_QUERY_IMPRESSIONS,
    limit: options.limit ?? 200,
  });

  const keys = [...new Set(queries.map((row) => row.queryKey).filter(Boolean))];
  // An alias is stored under the knowledge base's own label key, which spaces
  // words where the search term key underscores them. Comparing the two forms
  // directly would make every phrase look like a new one.
  const [approved, internal] = await Promise.all([
    approvedAliasKeys(executor, queries.map((row) => labelKey(row.query))),
    internalSearchCounts(executor, keys),
  ]);

  const recommendations: LearningRecommendation[] = [];

  for (const row of queries) {
    if (!row.queryKey || approved.has(labelKey(row.query))) continue;
    // Only a phrase that lands on one of this shop's own listings is a
    // candidate for that listing's vocabulary.
    if (!row.productId) continue;
    const alsoSearchedHere = internal.get(row.queryKey) ?? 0;
    recommendations.push({
      kind: "alias_candidate",
      subject: row.pagePath ?? row.query,
      productId: row.productId,
      pagePath: row.pagePath,
      phrase: row.query,
      phraseKey: row.queryKey,
      evidence: {
        impressions: row.impressions,
        clicks: row.clicks,
        position: Number(row.position.toFixed(2)),
        searchedOnThisSite: alsoSearchedHere,
      },
      recommendation:
        alsoSearchedHere > 0
          ? `People ask Google for “${row.query}” and reach this listing, and ${alsoSearchedHere} search${alsoSearchedHere === 1 ? "" : "es"} on this site used the same words. If that is another name for this product, suggest it as an alias.`
          : `People ask Google for “${row.query}” and reach this listing. If that is another name for this product, suggest it as an alias.`,
      requiresReview: "Suggesting the alias is one decision; approving it is a second, and only the approval changes search.",
    });
  }

  for (const gap of report.opportunities.filter((row) => row.kind === "content_gap")) {
    recommendations.push(terminologyFrom(gap));
  }
  for (const win of report.improvements) {
    recommendations.push({
      kind: "leave_alone",
      subject: win.subject,
      productId: win.productId,
      pagePath: win.pagePath,
      phrase: null,
      phraseKey: null,
      evidence: win.evidence,
      recommendation: `${win.observation} Recorded so this page is not rewritten while it is doing well.`,
      requiresReview: "Nothing to decide. This is a note, not a task.",
    });
  }

  return { connected: true, window: report.window, recommendations, guardrails: GUARDRAILS };
}

function terminologyFrom(gap: Opportunity): LearningRecommendation {
  return {
    kind: "terminology",
    subject: gap.subject,
    productId: gap.productId,
    pagePath: gap.pagePath,
    phrase: typeof gap.evidence.query === "string" ? gap.evidence.query : null,
    phraseKey: null,
    evidence: gap.evidence,
    recommendation: `${gap.observation} Decide whether the page should use those words.`,
    requiresReview: "A person edits the listing. Nothing here changes copy, and nothing becomes a product fact.",
  };
}

/** Which of these phrases are already approved aliases of something. */
async function approvedAliasKeys(executor: Executor, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows: { aliasNormalized: string }[] = await executor
    .selectDistinct({ aliasNormalized: pkbAliases.aliasNormalized })
    .from(pkbAliases)
    .where(and(eq(pkbAliases.status, "approved"), inArray(pkbAliases.aliasNormalized, keys)));
  return new Set(rows.map((row) => row.aliasNormalized));
}

/** How far back the internal search log is read for corroboration. */
const INTERNAL_SEARCH_DAYS = 90;

/**
 * How often each phrase was searched on this site. Aggregated counts only —
 * no visitor, no account, nothing that could identify who searched (I-9).
 */
async function internalSearchCounts(executor: Executor, keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const rows = await queryRows<{ query_norm: string; searches: number }>(
    executor,
    sql`
      select query_norm, count(*)::int as searches
      from search_queries
      where created_at >= now() - ${`${INTERNAL_SEARCH_DAYS} days`}::interval
      group by query_norm
    `,
  );
  const wanted = new Set(keys);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = termKey(row.query_norm);
    if (!wanted.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + row.searches);
  }
  return counts;
}
