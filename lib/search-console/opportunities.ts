import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { products, seoOpportunityDecisions } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import { isStopword } from "@/lib/search/normalize";
import { termKey } from "@/lib/search/terms";
import { stripHtml } from "@/lib/seo-pulse/text";
import { addDays } from "./config";
import {
  configuredProperty,
  coverageFor,
  daysWithData,
  pagePerformance,
  performanceRowCount,
  queryPerformance,
  windowLength,
  type PagePerformance,
  type QueryPerformance,
  type Window,
} from "./metrics";
import { SearchConsoleError } from "./sync";

/**
 * What the measurements say is worth doing (D-097).
 *
 * The rules below are arithmetic over rows Search Console actually reported.
 * There is no score, no estimated traffic, no keyword difficulty and no
 * competitor figure, because this shop has no way to measure any of those and
 * a plausible number is worse than an absent one. Where a rule cannot be
 * applied — not enough impressions, not enough days, no benchmark — the answer
 * is `insufficient_data` with the reason, not a quiet omission.
 *
 * The expected click-through rate a "low CTR" is judged against comes from
 * *this site's own* pages at similar positions, never from a published
 * industry table. A table would be someone else's data presented as this
 * shop's measurement.
 */

export const OPPORTUNITY_KINDS = [
  /** Plenty of impressions, far fewer clicks than this site's pages get at that position. */
  "low_ctr",
  /** A real query the page's own wording never uses. */
  "content_gap",
  /** Ranking just off the first page, with enough impressions to be worth work. */
  "improvement_potential",
  /** Measurably fewer clicks than the window before. */
  "decline",
  /** Measurably more clicks than the window before — record it and leave it alone. */
  "improvement",
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** The thresholds, in one place, so every figure on a screen can be explained. */
export const THRESHOLDS = {
  /** A page needs this many impressions in the window before its CTR means anything. */
  MIN_PAGE_IMPRESSIONS: 100,
  /** Below this share of its position band's median CTR, a page is worth a look. */
  LOW_CTR_RATIO: 0.5,
  /** A position band needs this many pages before its median is a benchmark. */
  MIN_BAND_PAGES: 5,
  /** The band where work usually pays: off the first page but in sight of it. */
  STRIKING_MIN_POSITION: 5,
  STRIKING_MAX_POSITION: 20,
  MIN_STRIKING_IMPRESSIONS: 50,
  /** A query has to be asked this often before its wording is worth changing a page for. */
  MIN_QUERY_IMPRESSIONS: 30,
  /** A change of fewer clicks than this is noise, however large the percentage. */
  MIN_CLICK_CHANGE: 10,
  /** And it has to be at least this share of the earlier window. */
  MIN_CHANGE_RATIO: 0.3,
  /** A window with less than this share of its days measured is not compared. */
  MIN_WINDOW_COVERAGE: 0.8,
} as const;

/**
 * How much of a window one report reads (risk R-16).
 *
 * The engine deliberately reads a bounded number of rows, most-shown first: a
 * property with tens of thousands of addresses would otherwise pull all of them
 * into memory to draw one screen, and the pages that account for the
 * impressions sort first anyway. The bound is safe *because* the report says
 * what it left out — `coverage` on the report and a note in `insufficient` —
 * so a slice is never presented as the whole. The ceilings exist so a caller
 * asking for more cannot ask for everything.
 */
export const OPPORTUNITY_LIMITS = {
  pages: 500,
  queries: 500,
  maxPages: 5_000,
  maxQueries: 5_000,
} as const;

/** Position bands, in the order they are tested. */
const BANDS: { key: string; label: string; from: number; to: number }[] = [
  { key: "1-3", label: "positions 1 to 3", from: 0, to: 3 },
  { key: "3-5", label: "positions 3 to 5", from: 3, to: 5 },
  { key: "5-10", label: "positions 5 to 10", from: 5, to: 10 },
  { key: "10-20", label: "positions 10 to 20", from: 10, to: 20 },
  { key: "20+", label: "position 20 and beyond", from: 20, to: Number.POSITIVE_INFINITY },
];

function bandOf(position: number) {
  return BANDS.find((band) => position >= band.from && position < band.to) ?? BANDS[BANDS.length - 1];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export type OpportunityEvidence = Record<string, string | number | null>;

export type Opportunity = {
  /** Stable across recomputations, so a decision about one can be stored. */
  key: string;
  kind: OpportunityKind;
  entityType: "product" | "category" | "site";
  productId: string | null;
  categoryId: string | null;
  pagePath: string | null;
  /** What the page is called, for a screen. */
  subject: string;
  /** What was measured, stated as a fact. */
  observation: string;
  /** What a person could do. Never done automatically. */
  recommendation: string;
  /** The numbers behind it. */
  evidence: OpportunityEvidence;
  /** The decision somebody already recorded about this one, if any. */
  decision: { decision: string; note: string | null; decidedAt: Date } | null;
};

export type InsufficientData = {
  /** What could not be judged. */
  subject: string;
  reason: string;
};

export type OpportunityReport = {
  /** Null when Search Console is not connected. */
  property: string | null;
  connected: boolean;
  window: Window | null;
  previousWindow: Window | null;
  windowComplete: boolean;
  opportunities: Opportunity[];
  improvements: Opportunity[];
  insufficient: InsufficientData[];
  /** The benchmark each band produced, for the screen to show its working. */
  benchmarks: { band: string; label: string; pages: number; medianCtr: number | null }[];
  /**
   * Exactly how much of the window this report examined (risk R-16). A screen
   * showing the findings must be able to say "the 500 most-shown pages of
   * 4,213" rather than implying it looked at everything.
   */
  coverage: OpportunityCoverage;
};

export type OpportunityCoverage = {
  pagesConsidered: number;
  pagesAvailable: number;
  pagesTruncated: boolean;
  queriesConsidered: number;
  queriesAvailable: number;
  queriesTruncated: boolean;
};

const NO_COVERAGE: OpportunityCoverage = {
  pagesConsidered: 0,
  pagesAvailable: 0,
  pagesTruncated: false,
  queriesConsidered: 0,
  queriesAvailable: 0,
  queriesTruncated: false,
};

const EMPTY: OpportunityReport = {
  property: null,
  connected: false,
  window: null,
  previousWindow: null,
  windowComplete: false,
  opportunities: [],
  improvements: [],
  insufficient: [],
  benchmarks: [],
  coverage: NO_COVERAGE,
};

function keyFor(kind: OpportunityKind, path: string, extra = ""): string {
  return [kind, path, extra].filter(Boolean).join("|").slice(0, 400);
}

/**
 * The words a query uses that carry meaning — long enough to matter and not a
 * stop word. Anything shorter is noise in a comparison against page copy.
 */
function meaningfulWords(query: string): string[] {
  return termKey(query)
    .split("_")
    .filter((word) => word.length >= 3 && !isStopword(word));
}

/** Everything a shopper can read on a listing, as comparison terms. */
function pageTerms(listing: {
  title: string;
  seoMetaTitle: string | null;
  seoMetaDescription: string | null;
  descriptionHtml: string | null;
  bulletFeatures: unknown;
  tags: unknown;
  searchKeywords: string | null;
}): Set<string> {
  const parts = [
    listing.title,
    listing.seoMetaTitle ?? "",
    listing.seoMetaDescription ?? "",
    stripHtml(listing.descriptionHtml ?? ""),
    Array.isArray(listing.bulletFeatures) ? listing.bulletFeatures.join(" ") : "",
    Array.isArray(listing.tags) ? listing.tags.join(" ") : "",
    listing.searchKeywords ?? "",
  ];
  return new Set(termKey(parts.join(" ")).split("_").filter(Boolean));
}

/**
 * The opportunities across the catalogue, for one window and the window before
 * it. Read-only: nothing here writes a row.
 */
export async function opportunityReport(
  actor: SessionUser | null,
  options: { windowDays?: number; executor?: Executor; pageLimit?: number; queryLimit?: number } = {},
): Promise<OpportunityReport> {
  requirePermission(actor, "seo.view");
  const executor = options.executor ?? db;
  const property = configuredProperty();
  if (!property) return EMPTY;

  const coverage = await coverageFor(executor, property);
  if (!coverage.latest) {
    return {
      ...EMPTY,
      property,
      connected: true,
      insufficient: [{ subject: "Everything", reason: "No Search Console measurements have been stored yet." }],
    };
  }

  const days = options.windowDays ?? 28;
  // Windows end at the last day measured, not today: the days Search Console
  // has not reported yet would otherwise look like a collapse in traffic.
  const window: Window = { start: addDays(coverage.latest, -(days - 1)), end: coverage.latest };
  const previousWindow: Window = { start: addDays(window.start, -days), end: addDays(window.start, -1) };

  const measuredDays = await daysWithData(executor, property, window);
  const previousMeasured = await daysWithData(executor, property, previousWindow);
  const windowComplete = measuredDays >= windowLength(window) * THRESHOLDS.MIN_WINDOW_COVERAGE;
  const canCompare = windowComplete && previousMeasured >= windowLength(previousWindow) * THRESHOLDS.MIN_WINDOW_COVERAGE;

  // Bounded, most-shown first, and counted so the report can say so (R-16).
  const pageLimit = Math.min(Math.max(options.pageLimit ?? OPPORTUNITY_LIMITS.pages, 50), OPPORTUNITY_LIMITS.maxPages);
  const [current, pagesAvailable] = await Promise.all([
    pagePerformance(executor, property, window, { limit: pageLimit }),
    performanceRowCount(executor, property, window, { dimension: "page" }),
  ]);
  const previous = canCompare ? await pagePerformance(executor, property, previousWindow, { limit: pageLimit }) : [];
  const previousByPath = new Map(previous.map((row) => [row.pagePath, row]));

  const insufficient: InsufficientData[] = [];
  if (!windowComplete) {
    insufficient.push({
      subject: "The whole window",
      reason: `Only ${measuredDays} of the ${windowLength(window)} days in the window have measurements, so nothing is compared.`,
    });
  } else if (!canCompare) {
    insufficient.push({
      subject: "Comparisons with the earlier period",
      reason: `The ${windowLength(previousWindow)} days before this window have only ${previousMeasured} days of measurements, so rises and falls are not reported.`,
    });
  }

  const pagesTruncated = pagesAvailable > current.length;
  if (pagesTruncated) {
    insufficient.push({
      subject: "The pages covered",
      reason:
        `This report covers the ${current.length.toLocaleString("en-GB")} most-shown pages of the ` +
        `${pagesAvailable.toLocaleString("en-GB")} that had impressions in the window. Pages below that are not ` +
        `examined, and the click-through benchmarks are the median of the pages that are.`,
    });
  }

  const benchmarks = buildBenchmarks(current, insufficient);
  const titles = await pageTitles(executor, current);

  const opportunities: Opportunity[] = [];
  const improvements: Opportunity[] = [];

  for (const page of current) {
    const subject = titles.get(page.pagePath) ?? page.pagePath;

    // 1. High impressions, low click-through for where it ranks.
    if (page.impressions >= THRESHOLDS.MIN_PAGE_IMPRESSIONS) {
      const band = bandOf(page.position);
      const benchmark = benchmarks.find((row) => row.band === band.key);
      if (benchmark?.medianCtr != null && page.ctr < benchmark.medianCtr * THRESHOLDS.LOW_CTR_RATIO) {
        opportunities.push({
          key: keyFor("low_ctr", page.pagePath),
          kind: "low_ctr",
          entityType: page.productId ? "product" : page.categoryId ? "category" : "site",
          productId: page.productId,
          categoryId: page.categoryId,
          pagePath: page.pagePath,
          subject,
          observation: `${page.impressions.toLocaleString("en-GB")} impressions and ${page.clicks.toLocaleString("en-GB")} clicks — ${(page.ctr * 100).toFixed(2)}% — at an average position of ${page.position.toFixed(1)}. This site's pages at ${band.label} are clicked ${(benchmark.medianCtr * 100).toFixed(2)}% of the time.`,
          recommendation:
            "Read the SEO title and meta description as a search result. They are what a person chooses between; the ranking is already there.",
          evidence: {
            impressions: page.impressions,
            clicks: page.clicks,
            ctr: Number((page.ctr * 100).toFixed(4)),
            position: Number(page.position.toFixed(2)),
            bandMedianCtr: Number((benchmark.medianCtr * 100).toFixed(4)),
            band: band.key,
          },
          decision: null,
        });
      }
    }

    // 2. Ranking within reach of the first page.
    if (
      page.impressions >= THRESHOLDS.MIN_STRIKING_IMPRESSIONS &&
      page.position >= THRESHOLDS.STRIKING_MIN_POSITION &&
      page.position <= THRESHOLDS.STRIKING_MAX_POSITION
    ) {
      opportunities.push({
        key: keyFor("improvement_potential", page.pagePath),
        kind: "improvement_potential",
        entityType: page.productId ? "product" : page.categoryId ? "category" : "site",
        productId: page.productId,
        categoryId: page.categoryId,
        pagePath: page.pagePath,
        subject,
        observation: `Average position ${page.position.toFixed(1)} on ${page.impressions.toLocaleString("en-GB")} impressions. It is being shown, but below where most people look.`,
        recommendation:
          "Check what this page can say that it does not: established specifications, a fuller description, photographs with descriptions, links from related listings.",
        evidence: {
          impressions: page.impressions,
          clicks: page.clicks,
          position: Number(page.position.toFixed(2)),
          ctr: Number((page.ctr * 100).toFixed(4)),
        },
        decision: null,
      });
    }

    // 3. and 4. Rises and falls against the window before.
    if (canCompare) {
      const before = previousByPath.get(page.pagePath);
      const beforeClicks = before?.clicks ?? 0;
      const change = page.clicks - beforeClicks;
      const ratio = beforeClicks > 0 ? Math.abs(change) / beforeClicks : change > 0 ? 1 : 0;
      if (Math.abs(change) >= THRESHOLDS.MIN_CLICK_CHANGE && ratio >= THRESHOLDS.MIN_CHANGE_RATIO) {
        const falling = change < 0;
        const entry: Opportunity = {
          key: keyFor(falling ? "decline" : "improvement", page.pagePath, window.end),
          kind: falling ? "decline" : "improvement",
          entityType: page.productId ? "product" : page.categoryId ? "category" : "site",
          productId: page.productId,
          categoryId: page.categoryId,
          pagePath: page.pagePath,
          subject,
          observation: `${beforeClicks.toLocaleString("en-GB")} clicks in the ${windowLength(previousWindow)} days to ${previousWindow.end}, ${page.clicks.toLocaleString("en-GB")} in the ${windowLength(window)} days to ${window.end}. Average position moved from ${(before?.position ?? 0).toFixed(1)} to ${page.position.toFixed(1)}.`,
          recommendation: falling
            ? "Look at what changed on this page and around it in that period — the SEO change history for this listing is the place to start. A fall in impressions is a different problem from a fall in clicks."
            : "Nothing to do. Recorded so the page is not rewritten while it is doing well.",
          evidence: {
            clicksBefore: beforeClicks,
            clicksAfter: page.clicks,
            impressionsBefore: before?.impressions ?? 0,
            impressionsAfter: page.impressions,
            positionBefore: before ? Number(before.position.toFixed(2)) : null,
            positionAfter: Number(page.position.toFixed(2)),
          },
          decision: null,
        };
        if (falling) opportunities.push(entry);
        else improvements.push(entry);
      }
    }
  }

  // 5. Queries a page is shown for but never says — bounded the same way.
  const queryLimit = Math.min(
    Math.max(options.queryLimit ?? OPPORTUNITY_LIMITS.queries, 50),
    OPPORTUNITY_LIMITS.maxQueries,
  );
  const gaps = await contentGaps(executor, property, window, current, titles, queryLimit);
  opportunities.push(...gaps.opportunities);
  if (gaps.truncated) {
    insufficient.push({
      subject: "The searches covered",
      reason:
        `The wording check read the ${gaps.considered.toLocaleString("en-GB")} most-shown page-and-search rows of ` +
        `the ${gaps.available.toLocaleString("en-GB")} in the window. Searches below that are not compared against ` +
        `page copy.`,
    });
  }

  const withDecisions = await attachDecisions(executor, [...opportunities, ...improvements]);
  const decided = new Map(withDecisions.map((row) => [row.key, row]));

  return {
    property,
    connected: true,
    window,
    previousWindow: canCompare ? previousWindow : null,
    windowComplete,
    coverage: {
      pagesConsidered: current.length,
      pagesAvailable,
      pagesTruncated,
      queriesConsidered: gaps.considered,
      queriesAvailable: gaps.available,
      queriesTruncated: gaps.truncated,
    },
    opportunities: opportunities.map((row) => decided.get(row.key) ?? row),
    improvements: improvements.map((row) => decided.get(row.key) ?? row),
    insufficient,
    benchmarks,
  };
}

/** The site's own median CTR per position band, or nothing where there is too little to say. */
function buildBenchmarks(pages: PagePerformance[], insufficient: InsufficientData[]) {
  return BANDS.map((band) => {
    const inBand = pages.filter(
      (page) => page.impressions >= THRESHOLDS.MIN_PAGE_IMPRESSIONS && page.position >= band.from && page.position < band.to,
    );
    if (inBand.length < THRESHOLDS.MIN_BAND_PAGES) {
      if (inBand.length > 0) {
        insufficient.push({
          subject: `Click-through at ${band.label}`,
          reason: `Only ${inBand.length} page${inBand.length === 1 ? "" : "s"} there has enough impressions; ${THRESHOLDS.MIN_BAND_PAGES} are needed before this site's own rate is a fair comparison.`,
        });
      }
      return { band: band.key, label: band.label, pages: inBand.length, medianCtr: null };
    }
    return { band: band.key, label: band.label, pages: inBand.length, medianCtr: median(inBand.map((page) => page.ctr)) };
  });
}

/** Listing titles for the pages in the report, so a screen does not show bare paths. */
async function pageTitles(executor: Executor, pages: PagePerformance[]): Promise<Map<string, string>> {
  const ids = [...new Set(pages.map((page) => page.productId).filter((id): id is string => Boolean(id)))];
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const rows: { id: string; title: string }[] = await executor
    .select({ id: products.id, title: products.title })
    .from(products)
    .where(inArray(products.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row.title]));
  for (const page of pages) {
    const title = page.productId ? byId.get(page.productId) : undefined;
    if (title) titles.set(page.pagePath, title);
  }
  return titles;
}

/**
 * A query the page is shown for whose words the page never uses. That is a
 * terminology gap: people are asking in words this listing does not speak.
 *
 * It is a recommendation to a person, never a rewrite and never an alias. A
 * query becoming vocabulary needs the two human steps D-094 established.
 */
async function contentGaps(
  executor: Executor,
  property: string,
  window: Window,
  pages: PagePerformance[],
  titles: Map<string, string>,
  limit: number,
): Promise<{ opportunities: Opportunity[]; considered: number; available: number; truncated: boolean }> {
  const productPages = pages.filter((page) => page.productId);
  if (productPages.length === 0) return { opportunities: [], considered: 0, available: 0, truncated: false };

  const [queries, available] = await Promise.all([
    queryPerformance(executor, property, window, {
      // A gap is about one page's wording, so it needs the page-and-query rows.
      dimension: "page_query",
      minImpressions: THRESHOLDS.MIN_QUERY_IMPRESSIONS,
      limit,
    }),
    performanceRowCount(executor, property, window, {
      dimension: "page_query",
      minImpressions: THRESHOLDS.MIN_QUERY_IMPRESSIONS,
    }),
  ]);
  const byPath = new Map<string, QueryPerformance[]>();
  for (const row of queries) {
    if (!row.pagePath) continue;
    byPath.set(row.pagePath, [...(byPath.get(row.pagePath) ?? []), row]);
  }
  // With no page-and-query rows there is nothing to compare a page's wording
  // against; that dimension only exists once a sync has stored it.
  if (byPath.size === 0) {
    return { opportunities: [], considered: queries.length, available, truncated: available > queries.length };
  }

  const ids = [...new Set(productPages.map((page) => page.productId!))];
  const listings: {
    id: string;
    title: string;
    seoMetaTitle: string | null;
    seoMetaDescription: string | null;
    descriptionHtml: string | null;
    bulletFeatures: unknown;
    tags: unknown;
    searchKeywords: string | null;
  }[] = await executor
    .select({
      id: products.id,
      title: products.title,
      seoMetaTitle: products.seoMetaTitle,
      seoMetaDescription: products.seoMetaDescription,
      descriptionHtml: products.descriptionHtml,
      bulletFeatures: products.bulletFeatures,
      tags: products.tags,
      searchKeywords: products.searchKeywords,
    })
    .from(products)
    .where(inArray(products.id, ids));
  const termsById = new Map(listings.map((listing) => [listing.id, pageTerms(listing)]));

  const found: Opportunity[] = [];
  for (const page of productPages) {
    const terms = termsById.get(page.productId!);
    if (!terms) continue;
    for (const row of byPath.get(page.pagePath) ?? []) {
      const words = meaningfulWords(row.query);
      if (words.length === 0) continue;
      const missing = words.filter((word) => !terms.has(word));
      if (missing.length === 0) continue;
      found.push({
        key: keyFor("content_gap", page.pagePath, row.queryKey),
        kind: "content_gap",
        entityType: "product",
        productId: page.productId,
        categoryId: null,
        pagePath: page.pagePath,
        subject: titles.get(page.pagePath) ?? page.pagePath,
        observation: `Shown ${row.impressions.toLocaleString("en-GB")} times for “${row.query}”, which this page never says: ${missing.map((word) => `“${word.replace(/_/g, " ")}”`).join(", ")}.`,
        recommendation:
          "Decide whether this page should use that wording. If the words describe what the product is, they belong in the copy or as an approved alias — both are a person's decision, not an automatic edit.",
        evidence: {
          query: row.query,
          impressions: row.impressions,
          clicks: row.clicks,
          position: Number(row.position.toFixed(2)),
          missingWords: missing.join(", "),
        },
        decision: null,
      });
    }
  }
  return { opportunities: found, considered: queries.length, available, truncated: available > queries.length };
}

/** Decisions staff already recorded, matched back onto the recomputed list. */
async function attachDecisions(executor: Executor, opportunities: Opportunity[]): Promise<Opportunity[]> {
  if (opportunities.length === 0) return [];
  const keys = opportunities.map((row) => row.key);
  const rows: { opportunityKey: string; decision: string; note: string | null; decidedAt: Date }[] = await executor
    .select({
      opportunityKey: seoOpportunityDecisions.opportunityKey,
      decision: seoOpportunityDecisions.decision,
      note: seoOpportunityDecisions.note,
      decidedAt: seoOpportunityDecisions.decidedAt,
    })
    .from(seoOpportunityDecisions)
    .where(inArray(seoOpportunityDecisions.opportunityKey, keys));
  const byKey = new Map(rows.map((row) => [row.opportunityKey, row]));
  return opportunities.map((row) => {
    const decision = byKey.get(row.key);
    return decision
      ? { ...row, decision: { decision: decision.decision, note: decision.note, decidedAt: decision.decidedAt } }
      : row;
  });
}

/**
 * Records what a person decided about an opportunity: acted on it, dismissed
 * it, or is watching it. The opportunity itself is still recomputed from the
 * measurements every time — this stores the decision, not the finding.
 */
export async function decideOpportunity(
  actor: SessionUser | null,
  input: {
    opportunityKey: string;
    kind: string;
    entityType: "product" | "category" | "site";
    productId?: string | null;
    categoryId?: string | null;
    decision: "acted" | "dismissed" | "watching";
    note?: string | null;
    evidence?: OpportunityEvidence | null;
  },
): Promise<{ decision: string }> {
  const staff = requirePermission(actor, "catalog.manage");
  if (!input.opportunityKey.trim()) throw new SearchConsoleError("That opportunity was not named.");

  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(seoOpportunityDecisions)
      .values({
        opportunityKey: input.opportunityKey.slice(0, 400),
        kind: input.kind.slice(0, 60),
        entityType: input.entityType,
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        decision: input.decision,
        note: input.note?.slice(0, 500) ?? null,
        evidence: input.evidence ?? null,
        decidedBy: staff.id,
        decidedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: seoOpportunityDecisions.opportunityKey,
        set: {
          decision: input.decision,
          note: input.note?.slice(0, 500) ?? null,
          evidence: input.evidence ?? null,
          decidedBy: staff.id,
          decidedAt: now,
          updatedAt: now,
        },
      });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "seo.opportunity_decided",
        entityType: input.entityType === "product" ? "product" : input.entityType === "category" ? "category" : "search_console",
        entityId: input.productId ?? input.categoryId ?? input.opportunityKey.slice(0, 120),
        after: { opportunityKey: input.opportunityKey, kind: input.kind, decision: input.decision },
      },
      tx,
    );
    return { decision: input.decision };
  });
}

/** One listing's opportunities, for the product editor. */
export async function listingOpportunities(
  actor: SessionUser | null,
  productId: string,
  options: { windowDays?: number; executor?: Executor } = {},
): Promise<Opportunity[]> {
  const report = await opportunityReport(actor, options);
  return [...report.opportunities, ...report.improvements].filter((row) => row.productId === productId);
}

