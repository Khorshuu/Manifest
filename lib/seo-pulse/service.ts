import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  productImages,
  products,
  productVariants,
  reviews,
  searchClicks,
  searchQueries,
  searchSynonyms,
  seoResearchRuns,
  users,
  type ProductCompliance,
  type ProductWarranty,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { resolveCategoryAttributes } from "@/lib/catalog/category-attributes";
import { updateProductImageAltText } from "@/lib/catalog/media";
import { slugTaken, updateProduct } from "@/lib/catalog/products";
import { getSeoPulseConfig } from "./config";
import { isStopword } from "@/lib/search/normalize";
import { createSynonym } from "@/lib/search/synonyms";
import { productPatchSchema } from "@/lib/validation/catalog";
import { synonymInputSchema } from "@/lib/validation/search";
import type { SeoPulseApplyPayload } from "@/lib/validation/seo-pulse";
import {
  competitorObservations,
  contentGaps,
  identifierStatus,
  imageFilenames,
  keywordGroups,
  schemaReadiness,
} from "./facts";
import { getSeoDataProvider, unavailableUsage } from "./providers/data";
import {
  getIntelligenceProvider,
  RulesIntelligenceProvider,
  type IntelligenceResult,
} from "./providers/intelligence";
import { coreName, generateByRules } from "./rules";
import { sanitizeDescriptionHtml } from "./sanitize";
import { searchScore, seoScore } from "./scores";
import { hashValue, isSuperset, keywordKey, normalizeKeyword, stripHtml } from "./text";
import {
  PULSE_VERSION,
  STALE_AFTER_DAYS,
  type ApplyField,
  type KeywordMetric,
  type ProductPulseStatus,
  type ProviderUsage,
  type SeoAnalysis,
  type SeoPulseInput,
  type SeoResearchData,
  type SerpSnapshot,
  type SiteSearchResearch,
} from "./types";

/**
 * SEO Pulse, end to end: gather the product, research it, analyse it, store
 * the run, and apply what staff approve (DECISIONS.md D-038).
 *
 * Every entry point asks for `catalog.manage` itself, so a route that forgot
 * to check still cannot run research or write to a product
 * (docs/SECURITY.md). Nothing here publishes, prices, stocks, re-files or
 * deletes anything.
 */

export class SeoPulseError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "SeoPulseError";
    this.status = status;
    this.details = details;
  }
}

const DAY_MS = 86_400_000;
/** A run still "running" after this long is treated as abandoned. */
const RUNNING_TIMEOUT_MS = 3 * 60_000;
/** A matching run this recent is offered for reuse instead of a new one. */
const REUSE_WITHIN_MS = STALE_AFTER_DAYS * DAY_MS;
const SITE_SEARCH_WINDOW_DAYS = 90;

// ------------------------------------------------------------------ input

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** The product as SEO Pulse sees it. Null when the product does not exist. */
export async function loadPulseInput(productId: string): Promise<SeoPulseInput | null> {
  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) return null;

  const [images, allCategories, variants, [rating], definitions] = await Promise.all([
    db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(productImages.sortOrder, productImages.createdAt),
    db
      .select({ id: categories.id, parentId: categories.parentId, name: categories.name })
      .from(categories),
    db
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, productId),
          isNull(productVariants.archivedAt),
          eq(productVariants.isEnabled, true),
        ),
      ),
    db
      .select({
        count: sql<number>`count(*)::int`,
        average: sql<number | null>`avg(${reviews.rating})::float`,
      })
      .from(reviews)
      .where(and(eq(reviews.productId, productId), eq(reviews.status, "approved"))),
    resolveCategoryAttributes(product.categoryId),
  ]);

  const byId = new Map(allCategories.map((row) => [row.id, row]));
  const categoryPath: string[] = [];
  for (let cursor = byId.get(product.categoryId); cursor && categoryPath.length < 32; ) {
    categoryPath.unshift(cursor.name);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  const attributeValues = (product.attributeValues ?? {}) as Record<string, unknown>;
  const specifications = [
    ...((product.specTable as { label: string; value: string }[] | null) ?? []).filter(
      (row) => row.label?.trim() && row.value?.trim(),
    ),
    ...definitions.flatMap((definition) => {
      const value = attributeValues[definition.id];
      const shown = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
      return shown.trim()
        ? [{ label: definition.name, value: definition.unit ? `${shown} ${definition.unit}` : shown }]
        : [];
    }),
  ];

  const details = Object.fromEntries(
    Object.entries((product.details ?? {}) as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    ),
  );
  const warranty = product.warranty as ProductWarranty | null;
  const compliance = product.compliance as ProductCompliance | null;

  return {
    productId: product.id,
    title: product.title,
    slug: product.slug,
    brand: product.brand,
    sku: product.sku,
    identifierType: product.identifierType,
    identifierValue: product.identifierValue,
    categoryId: product.categoryId,
    categoryPath,
    status: product.status,
    descriptionText: stripHtml(product.descriptionHtml).slice(0, 6000),
    bulletFeatures: strings(product.bulletFeatures),
    specifications,
    details,
    boxContents: strings(product.boxContents),
    warranty: warranty
      ? { hasWarranty: warranty.hasWarranty, durationMonths: warranty.durationMonths ?? null }
      : null,
    countryOfOrigin: compliance?.countryOfOrigin ?? null,
    tags: strings(product.tags),
    searchKeywords: strings(product.searchKeywords),
    searchable: product.searchable,
    seoFocusKeyword: product.seoFocusKeyword,
    seoMetaTitle: product.seoMetaTitle,
    seoMetaDescription: product.seoMetaDescription,
    seoNoIndex: product.seoNoIndex,
    images: images.map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.altText,
      kind: image.kind === "lifestyle" ? "lifestyle" : "gallery",
    })),
    hasVideo: Boolean(product.videoUrl),
    variants: variants.map((variant) => ({
      label: variant.sku,
      priceBdt: variant.salePriceBdt ?? variant.priceBdt,
      fulfillmentMode: variant.fulfillmentMode,
      available:
        variant.fulfillmentMode === "in_stock"
          ? (variant.stockQuantity ?? 0) > 0
          : variant.preorderCapacity === null || variant.preorderReserved < variant.preorderCapacity,
      arrivesFrom: isoDate(variant.estimatedArrivalFrom),
      arrivesTo: isoDate(variant.estimatedArrivalTo),
    })),
    reviews: { count: Number(rating?.count ?? 0), average: rating?.average ?? null },
  };
}

/** The part of the input that, when it changes, makes research out of date. */
function hashInput(input: SeoPulseInput): string {
  return hashValue(input);
}

// --------------------------------------------------------------- research

function coreWords(input: SeoPulseInput): string[] {
  const words = keywordKey(`${input.brand ?? ""} ${coreName(input.title)}`)
    .split(" ")
    .filter((word) => word.length >= 3 && !isStopword(word));
  return [...new Set(words)].slice(0, 6);
}

/**
 * First-party research: what shoppers typed into this site's own search.
 * Real counts from `search_queries` and `search_clicks`, never estimates.
 */
export async function siteSearchResearch(input: SeoPulseInput): Promise<SiteSearchResearch> {
  const words = coreWords(input);
  const since = new Date(Date.now() - SITE_SEARCH_WINDOW_DAYS * DAY_MS);
  const needed = Math.min(2, words.length);
  const matches = (text: string) => {
    const present = new Set(keywordKey(text).split(" "));
    return words.filter((word) => present.has(word)).length >= needed;
  };

  const anyWord = words.length
    ? or(...words.map((word) => like(searchQueries.queryNorm, `%${word}%`)))
    : undefined;

  const [queryRows, clickRows, typoRows, synonymRows] = await Promise.all([
    anyWord
      ? db
          .select({
            query: searchQueries.queryNorm,
            searches: sql<number>`count(*)::int`,
            zero: sql<number>`count(*) filter (where ${searchQueries.resultsCount} = 0)::int`,
          })
          .from(searchQueries)
          .where(and(gt(searchQueries.createdAt, since), anyWord))
          .groupBy(searchQueries.queryNorm)
          .orderBy(desc(sql`count(*)`))
          .limit(200)
      : Promise.resolve([]),
    db
      .select({ query: searchClicks.queryNorm, clicks: sql<number>`count(*)::int` })
      .from(searchClicks)
      .where(and(eq(searchClicks.productId, input.productId), gt(searchClicks.createdAt, since)))
      .groupBy(searchClicks.queryNorm)
      .orderBy(desc(sql`count(*)`))
      .limit(10),
    db
      .select({
        typed: searchQueries.queryNorm,
        corrected: searchQueries.correctedQuery,
        searches: sql<number>`count(*)::int`,
      })
      .from(searchQueries)
      .where(and(gt(searchQueries.createdAt, since), isNotNull(searchQueries.correctedQuery)))
      .groupBy(searchQueries.queryNorm, searchQueries.correctedQuery)
      .orderBy(desc(sql`count(*)`))
      .limit(200),
    db
      .select({ term: searchSynonyms.term, synonyms: searchSynonyms.synonyms })
      .from(searchSynonyms)
      .limit(500),
  ]);

  return {
    source: "This site's own search log",
    windowDays: SITE_SEARCH_WINDOW_DAYS,
    researchedAt: new Date().toISOString(),
    matchingQueries: queryRows
      .filter((row) => matches(row.query))
      .slice(0, 15)
      .map((row) => ({
        query: row.query,
        searches: Number(row.searches),
        zeroResultSearches: Number(row.zero),
      })),
    queriesLeadingHere: clickRows.map((row) => ({ query: row.query, clicks: Number(row.clicks) })),
    correctedTypos: typoRows
      .filter((row) => row.corrected && matches(row.corrected) && row.typed !== normalizeKeyword(row.corrected))
      .slice(0, 10)
      .map((row) => ({
        typed: row.typed,
        corrected: row.corrected as string,
        searches: Number(row.searches),
      })),
    existingSynonyms: synonymRows,
  };
}

function usageRow(
  partial: Omit<ProviderUsage, "at" | "estimatedCostUsd" | "requests"> &
    Partial<Pick<ProviderUsage, "estimatedCostUsd" | "requests">>,
): ProviderUsage {
  return {
    requests: 0,
    estimatedCostUsd: null,
    ...partial,
    at: new Date().toISOString(),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error.";
}

/**
 * One full research-and-analysis pass. Each provider is isolated: one that
 * fails is recorded as failed and the rest carry on. Only the analysis step
 * is required, and it falls back to the rules generator if the AI fails.
 */
export async function executeResearch(input: SeoPulseInput) {
  const usage: ProviderUsage[] = [];

  let siteSearch: SiteSearchResearch | null = null;
  try {
    siteSearch = await siteSearchResearch(input);
    usage.push(
      usageRow({
        id: "site-search",
        label: "This site's search log",
        kind: "first_party",
        status: "ok",
        message: `${siteSearch.matchingQueries.length} matching queries in ${siteSearch.windowDays} days.`,
        requests: 1,
      }),
    );
  } catch (error) {
    usage.push(
      usageRow({
        id: "site-search",
        label: "This site's search log",
        kind: "first_party",
        status: "failed",
        message: errorText(error),
      }),
    );
  }

  // Candidate keywords to measure come from the product itself, before any
  // external data exists — the analysis below then chooses among them.
  const seeds = generateByRules(input, { siteSearch, keywordMetrics: [], serp: [] });
  const candidates = [
    seeds.primaryKeyword.keyword,
    ...seeds.secondaryKeywords.map((item) => item.keyword),
    ...seeds.longTailKeywords.map((item) => item.keyword),
  ].slice(0, 10);

  let keywordMetrics: KeywordMetric[] = [];
  const serp: SerpSnapshot[] = [];
  const provider = getSeoDataProvider();

  if (!provider) {
    usage.push(
      unavailableUsage(
        "External keyword data",
        "Research provider unavailable — no external keyword or search-results provider is configured.",
      ),
    );
  } else {
    const failures: string[] = [];
    try {
      keywordMetrics = await provider.keywordResearch(candidates);
    } catch (error) {
      failures.push(`Keyword data: ${errorText(error)}`);
    }
    try {
      serp.push(await provider.serpResearch(seeds.primaryKeyword.keyword));
    } catch (error) {
      failures.push(`Search results: ${errorText(error)}`);
    }
    const spent = provider.usage();
    usage.push(
      usageRow({
        id: provider.id,
        label: provider.label,
        kind: "external_data",
        status: failures.length === 2 ? "failed" : "ok",
        message: failures.length > 0 ? failures.join(" ") : `${keywordMetrics.length} keywords measured, ${serp.length} results page collected.`,
        requests: spent.requests,
        estimatedCostUsd: spent.costUsd,
      }),
    );
  }

  const research: SeoResearchData = { siteSearch, keywordMetrics, serp };
  const externalOk = keywordMetrics.length > 0 || serp.length > 0;

  const intelligence = getIntelligenceProvider();
  let result: IntelligenceResult;
  let kind: "ai" | "rules" = intelligence.kind;
  let providerLabel = intelligence.label;
  try {
    result = await intelligence.analyzeProduct(input, research);
    usage.push(
      usageRow({
        id: intelligence.id,
        label: intelligence.label,
        kind: intelligence.kind,
        status: "ok",
        message: result.model ? `Model ${result.model}.` : null,
        requests: intelligence.kind === "ai" ? 1 : 0,
        estimatedCostUsd: result.estimatedCostUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }),
    );
  } catch (error) {
    if (intelligence.kind === "rules") throw error;
    usage.push(
      usageRow({
        id: intelligence.id,
        label: intelligence.label,
        kind: "ai",
        status: "failed",
        message: `AI provider unavailable: ${errorText(error)} The rules generator was used instead.`,
        requests: 1,
      }),
    );
    const fallback = new RulesIntelligenceProvider();
    result = await fallback.analyzeProduct(input, research);
    kind = "rules";
    providerLabel = fallback.label;
  }

  const generated = result.generated;
  if (generated.description.suggestedHtml) {
    generated.description.suggestedHtml =
      sanitizeDescriptionHtml(generated.description.suggestedHtml) || null;
  }

  const label =
    kind === "ai"
      ? externalOk
        ? "AI-generated recommendation, based on collected research"
        : "AI-generated recommendation — external research unavailable"
      : externalOk
        ? "Rule-based recommendation, based on collected research"
        : "Rule-based recommendation from product data — external research unavailable";

  const slugConflict =
    generated.slug.recommended !== input.slug &&
    (await slugTaken(generated.slug.recommended, input.productId));

  const analysis: SeoAnalysis = {
    ...generated,
    generator: { kind, provider: providerLabel, model: result.model, label },
    keywordGroups: keywordGroups(generated),
    slugConflict,
    imageFilenames: imageFilenames(input, generated.slug.recommended),
    contentGaps: contentGaps(input),
    identifiers: identifierStatus(input),
    schemaReadiness: schemaReadiness(input),
    competitorObservations: competitorObservations(serp),
    scores: { seo: seoScore(input), search: searchScore(input) },
  };

  return { research, analysis, usage };
}

// ------------------------------------------------------------------- runs

export type RunSummary = {
  id: string;
  productId: string;
  version: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
  initiatedBy: string | null;
  seoScore: number | null;
  searchScore: number | null;
  generatorLabel: string | null;
  appliedAt: string | null;
  appliedFields: string[];
  inputHash: string;
  pulseVersion: string;
  error: string | null;
};

export type RunDetail = RunSummary & {
  inputSnapshot: SeoPulseInput;
  research: SeoResearchData | null;
  analysis: SeoAnalysis | null;
  providerUsage: ProviderUsage[];
};

const runColumns = {
  run: seoResearchRuns,
  initiatedBy: users.email,
};

type RunRow = { run: typeof seoResearchRuns.$inferSelect; initiatedBy: string | null };

function toSummary({ run, initiatedBy }: RunRow): RunSummary {
  const analysis = run.analysis as SeoAnalysis | null;
  return {
    id: run.id,
    productId: run.productId,
    version: run.version,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    initiatedBy,
    seoScore: run.seoScore,
    searchScore: run.searchScore,
    generatorLabel: analysis?.generator.label ?? null,
    appliedAt: run.appliedAt?.toISOString() ?? null,
    appliedFields: strings(run.appliedFields),
    inputHash: run.inputHash,
    pulseVersion: run.pulseVersion,
    error: run.error,
  };
}

function toDetail(row: RunRow): RunDetail {
  return {
    ...toSummary(row),
    inputSnapshot: row.run.inputSnapshot as SeoPulseInput,
    research: row.run.research as SeoResearchData | null,
    analysis: row.run.analysis as SeoAnalysis | null,
    providerUsage: (row.run.providerUsage as ProviderUsage[] | null) ?? [],
  };
}

async function findRun(where: ReturnType<typeof eq>): Promise<RunRow | null> {
  const [row] = await db
    .select(runColumns)
    .from(seoResearchRuns)
    .leftJoin(users, eq(users.id, seoResearchRuns.initiatedBy))
    .where(where)
    .limit(1);
  return row ?? null;
}

async function insertRunningRow(
  actor: SessionUser,
  input: SeoPulseInput,
  inputHash: string,
  requestKey: string,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ next }] = await db
      .select({ next: sql<number>`coalesce(max(${seoResearchRuns.version}), 0)::int + 1` })
      .from(seoResearchRuns)
      .where(eq(seoResearchRuns.productId, input.productId));
    try {
      const [row] = await db
        .insert(seoResearchRuns)
        .values({
          productId: input.productId,
          version: Number(next),
          requestKey,
          initiatedBy: actor.id,
          inputSnapshot: input,
          inputHash,
          pulseVersion: PULSE_VERSION,
        })
        .returning();
      return row;
    } catch (error) {
      const message = `${errorText(error)} ${error instanceof Error && error.cause ? String(error.cause) : ""}`;
      if (/request_key/.test(message)) {
        throw new SeoPulseError("That request was already received.", 409);
      }
      // Two runs raced for the same version number; take the next one.
      if (!/version_unique|duplicate key/i.test(message)) throw error;
    }
  }
  throw new SeoPulseError("SEO Pulse is busy with this product. Try again in a moment.", 409);
}

/**
 * Starts research for a product, or returns research that already answers
 * the request:
 *
 *  - the same request key again returns the run it created (a retried click);
 *  - without `fresh`, a completed run for an unchanged product within
 *    STALE_AFTER_DAYS is reused, so opening and re-clicking costs nothing;
 *  - a run already in progress for this product refuses a second one;
 *  - each staff member may start SEO_PULSE_MAX_RUNS_PER_HOUR runs an hour.
 */
export async function runSeoPulse(
  actor: SessionUser | null,
  productId: string,
  options: { requestKey: string; fresh: boolean },
): Promise<{ run: RunDetail; reused: boolean }> {
  const staff = requirePermission(actor, "catalog.manage");

  const input = await loadPulseInput(productId);
  if (!input) throw new SeoPulseError("That product was not found.", 404);
  const inputHash = hashInput(input);

  const repeated = await findRun(eq(seoResearchRuns.requestKey, options.requestKey));
  if (repeated) {
    if (repeated.run.productId !== productId) {
      throw new SeoPulseError("That request key belongs to another product.", 409);
    }
    return { run: toDetail(repeated), reused: true };
  }

  if (!options.fresh) {
    const [recent] = await db
      .select(runColumns)
      .from(seoResearchRuns)
      .leftJoin(users, eq(users.id, seoResearchRuns.initiatedBy))
      .where(
        and(
          eq(seoResearchRuns.productId, productId),
          eq(seoResearchRuns.status, "completed"),
          eq(seoResearchRuns.inputHash, inputHash),
          gt(seoResearchRuns.createdAt, new Date(Date.now() - REUSE_WITHIN_MS)),
        ),
      )
      .orderBy(desc(seoResearchRuns.createdAt))
      .limit(1);
    if (recent) return { run: toDetail(recent), reused: true };
  }

  const [{ running }] = await db
    .select({ running: count() })
    .from(seoResearchRuns)
    .where(
      and(
        eq(seoResearchRuns.productId, productId),
        eq(seoResearchRuns.status, "running"),
        gt(seoResearchRuns.createdAt, new Date(Date.now() - RUNNING_TIMEOUT_MS)),
      ),
    );
  if (Number(running) > 0) {
    throw new SeoPulseError("SEO Pulse is already researching this product. Wait for it to finish.", 409);
  }

  const [{ recentRuns }] = await db
    .select({ recentRuns: count() })
    .from(seoResearchRuns)
    .where(
      and(
        eq(seoResearchRuns.initiatedBy, staff.id),
        gt(seoResearchRuns.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  if (Number(recentRuns) >= getSeoPulseConfig().SEO_PULSE_MAX_RUNS_PER_HOUR) {
    throw new SeoPulseError(
      "You have reached the hourly limit for SEO Pulse runs. Existing research is still available.",
      429,
    );
  }

  const row = await insertRunningRow(staff, input, inputHash, options.requestKey);

  try {
    const { research, analysis, usage } = await executeResearch(input);
    await db
      .update(seoResearchRuns)
      .set({
        status: "completed",
        research,
        analysis,
        providerUsage: usage,
        seoScore: analysis.scores.seo.score,
        searchScore: analysis.scores.search.score,
        completedAt: new Date(),
      })
      .where(eq(seoResearchRuns.id, row.id));
  } catch (error) {
    await db
      .update(seoResearchRuns)
      .set({ status: "failed", error: errorText(error), completedAt: new Date() })
      .where(eq(seoResearchRuns.id, row.id));
    throw new SeoPulseError(`SEO Pulse could not finish: ${errorText(error)}`, 502);
  }

  await recordAudit({
    actorUserId: staff.id,
    action: "seo_pulse.researched",
    entityType: "product",
    entityId: productId,
    after: { runId: row.id, version: row.version, fresh: options.fresh },
  });

  const saved = await findRun(eq(seoResearchRuns.id, row.id));
  return { run: toDetail(saved as RunRow), reused: false };
}

export async function getSeoPulseRun(
  actor: SessionUser | null,
  runId: string,
): Promise<RunDetail | null> {
  requirePermission(actor, "catalog.manage");
  const row = await findRun(eq(seoResearchRuns.id, runId));
  return row ? toDetail(row) : null;
}

export async function listProductRuns(
  actor: SessionUser | null,
  productId: string,
): Promise<RunSummary[]> {
  requirePermission(actor, "catalog.manage");
  const rows = await db
    .select(runColumns)
    .from(seoResearchRuns)
    .leftJoin(users, eq(users.id, seoResearchRuns.initiatedBy))
    .where(eq(seoResearchRuns.productId, productId))
    .orderBy(desc(seoResearchRuns.version))
    .limit(50);
  return rows.map(toSummary);
}

/** The panel status the product editor shows. Pure, so it is tested directly. */
export function pulseStatus(
  latest: Pick<RunSummary, "completedAt" | "createdAt" | "appliedAt" | "inputHash"> | null,
  currentHash: string,
  productUpdatedAt: Date,
  now = Date.now(),
): ProductPulseStatus {
  if (!latest) return "not_researched";
  if (latest.appliedAt) {
    // Applying saves the product a moment before the run records it.
    return productUpdatedAt.getTime() <= new Date(latest.appliedAt).getTime() + 5_000
      ? "applied"
      : "updated";
  }
  const age = now - new Date(latest.completedAt ?? latest.createdAt).getTime();
  if (age > STALE_AFTER_DAYS * DAY_MS || latest.inputHash !== currentHash) return "needs_refresh";
  return "available";
}

export type PulseOverview = {
  status: ProductPulseStatus;
  latest: RunDetail | null;
  history: RunSummary[];
  current: { seo: ReturnType<typeof seoScore>; search: ReturnType<typeof searchScore> };
  inputChanged: boolean;
  stale: boolean;
};

export async function getSeoPulseOverview(
  actor: SessionUser | null,
  productId: string,
): Promise<PulseOverview | null> {
  requirePermission(actor, "catalog.manage");
  const input = await loadPulseInput(productId);
  if (!input) return null;

  const [product] = await db
    .select({ updatedAt: products.updatedAt })
    .from(products)
    .where(eq(products.id, productId));

  const history = await listProductRuns(actor, productId);
  const latestCompleted = history.find((run) => run.status === "completed") ?? null;
  const latest = latestCompleted ? await getSeoPulseRun(actor, latestCompleted.id) : null;
  const hash = hashInput(input);

  return {
    status: pulseStatus(latestCompleted, hash, product.updatedAt),
    latest,
    history,
    current: { seo: seoScore(input), search: searchScore(input) },
    inputChanged: latestCompleted !== null && latestCompleted.inputHash !== hash,
    stale:
      latestCompleted !== null &&
      Date.now() - new Date(latestCompleted.completedAt ?? latestCompleted.createdAt).getTime() >
        STALE_AFTER_DAYS * DAY_MS,
  };
}

/** Recent runs across the catalogue, for Admin → SEO Pulse. */
export async function listRecentRuns(actor: SessionUser | null, limit = 30) {
  requirePermission(actor, "catalog.manage");
  const rows = await db
    .select({ ...runColumns, productTitle: products.title })
    .from(seoResearchRuns)
    .innerJoin(products, eq(products.id, seoResearchRuns.productId))
    .leftJoin(users, eq(users.id, seoResearchRuns.initiatedBy))
    .orderBy(desc(seoResearchRuns.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...toSummary(row), productTitle: row.productTitle }));
}

/** Live products that have never been researched. */
export async function listUnresearchedProducts(actor: SessionUser | null, limit = 20) {
  requirePermission(actor, "catalog.manage");
  const rows = await db
    .select({ id: products.id, title: products.title, status: products.status })
    .from(products)
    .where(
      and(
        isNull(products.archivedAt),
        sql`not exists (select 1 from ${seoResearchRuns} r where r.product_id = ${products.id})`,
      ),
    )
    .orderBy(desc(products.updatedAt))
    .limit(limit);
  const [{ total }] = await db
    .select({ total: count() })
    .from(products)
    .where(
      and(
        isNull(products.archivedAt),
        sql`not exists (select 1 from ${seoResearchRuns} r where r.product_id = ${products.id})`,
      ),
    );
  return { rows, total: Number(total) };
}

// ------------------------------------------------------------------- fill

/** Content gaps only the admin can close — facts SEO Pulse must not invent. */
const FACT_GAPS = new Set([
  "bullets",
  "dimensions",
  "weight",
  "material",
  "compatibility",
  "box",
  "warranty",
  "origin",
  "photos",
]);

export type FillResult = {
  runId: string;
  reused: boolean;
  generator: string;
  /** What SEO Pulse wrote into empty fields. */
  filled: string[];
  /** Fields that already had the admin's text, left alone. */
  kept: string[];
  /** Facts SEO Pulse cannot know; the admin should add them. */
  needsInput: string[];
  /** Photographs whose alt text SEO Pulse cannot write without seeing them. */
  imagesNeedReview: number;
};

function mergeTerms(existing: string[], extra: string[], max: number, maxLength: number) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const term of [...existing, ...extra]) {
    const trimmed = term.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || trimmed.length > maxLength || seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged.slice(0, max);
}

/**
 * The one-click SEO Pulse (D-040): research — reusing unchanged research —
 * then write into every empty field what the analysis can say reliably, and
 * report what was filled, what was kept, and which facts only the admin can
 * supply. Text the admin wrote is never replaced; lists are only added to.
 */
export async function fillWithSeoPulse(
  actor: SessionUser | null,
  productId: string,
): Promise<FillResult> {
  const staff = requirePermission(actor, "catalog.manage");
  const { run, reused } = await runSeoPulse(staff, productId, {
    requestKey: randomUUID(),
    fresh: false,
  });
  const analysis = run.analysis;
  if (!analysis) throw new SeoPulseError("SEO Pulse could not analyse this product. Review its information.", 502);

  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw new SeoPulseError("That product was not found.", 404);

  const fields: SeoPulseApplyPayload["fields"] = {};
  const filled: string[] = [];
  const kept: string[] = [];
  const empty = (value: string | null) => !value || !value.trim();

  const text = (
    key: "seoFocusKeyword" | "seoMetaTitle" | "seoMetaDescription" | "descriptionHtml",
    value: string | null | undefined,
    label: string,
  ) => {
    if (!value) return;
    if (empty(product[key])) {
      fields[key] = key === "descriptionHtml" ? sanitizeDescriptionHtml(value) : value;
      filled.push(label);
    } else {
      kept.push(label);
    }
  };

  text("seoFocusKeyword", analysis.primaryKeyword.keyword, "Focus keyword");
  text("seoMetaTitle", analysis.seoTitle.recommended, "SEO title");
  text("seoMetaDescription", analysis.metaDescription.recommended, "Meta description");
  text("descriptionHtml", analysis.description.suggestedHtml, "Description");

  const features = analysis.keyFeatures ?? [];
  if (features.length > 0) {
    if (strings(product.bulletFeatures).length === 0) {
      fields.bulletFeatures = features;
      filled.push("Key features");
    } else {
      kept.push("Key features");
    }
  }

  const tags = strings(product.tags);
  const nextTags = mergeTerms(tags, analysis.tags, 30, 40);
  if (nextTags.length > tags.length) {
    fields.tags = nextTags;
    filled.push(`Tags (+${nextTags.length - tags.length})`);
  }

  const keywords = strings(product.searchKeywords);
  const nextKeywords = mergeTerms(
    keywords,
    [
      ...analysis.searchAliases,
      ...analysis.misspellings.map((entry) => entry.term),
      ...analysis.searchPhrases,
      ...analysis.brandVariations,
    ],
    40,
    60,
  );
  if (nextKeywords.length > keywords.length) {
    fields.searchKeywords = nextKeywords;
    filled.push(`Search terms (+${nextKeywords.length - keywords.length})`);
  }

  if (Object.keys(fields).length > 0) {
    await applySeoPulse(staff, productId, { runId: run.id, fields, overwrite: [] });
  }

  return {
    runId: run.id,
    reused,
    generator: analysis.generator.label,
    filled,
    kept,
    needsInput: analysis.contentGaps.filter((gap) => FACT_GAPS.has(gap.key)).map((gap) => gap.label),
    imagesNeedReview: analysis.imageAlts.filter((image) => image.needsReview).length,
  };
}

// ------------------------------------------------------------------ apply

const TEXT_FIELDS = [
  "seoFocusKeyword",
  "seoMetaTitle",
  "seoMetaDescription",
  "slug",
  "title",
  "descriptionHtml",
] as const;

/**
 * Writes the recommendations staff approved.
 *
 * The rule that matters: a field that already holds something is only
 * replaced when staff named it in `overwrite`. A list counts as untouched
 * when every existing entry is still in the new one — adding keywords never
 * needs permission, dropping one does. Any conflict refuses the whole apply,
 * so nothing is half-written.
 *
 * The product itself is saved through `updateProduct`, the same path as the
 * editor's Save, so validation, the search index and the audit log all behave
 * exactly as they do for a manual edit.
 */
export async function applySeoPulse(
  actor: SessionUser | null,
  productId: string,
  payload: SeoPulseApplyPayload,
): Promise<{ applied: ApplyField[]; skipped: string[] }> {
  const staff = requirePermission(actor, "catalog.manage");
  const { fields } = payload;
  const overwrite = new Set(payload.overwrite);
  if (fields.synonyms?.length) requirePermission(staff, "search.manage");

  const run = await findRun(eq(seoResearchRuns.id, payload.runId));
  if (!run || run.run.productId !== productId) {
    throw new SeoPulseError("That research run was not found for this product.", 404);
  }
  if (run.run.status !== "completed") {
    throw new SeoPulseError("Only completed research can be applied.", 409);
  }

  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new SeoPulseError("That product was not found.", 404);

  const conflicts: { field: ApplyField; existing: unknown }[] = [];

  for (const field of TEXT_FIELDS) {
    const next = fields[field];
    if (next === undefined) continue;
    const current = (product[field] as string | null) ?? "";
    if (current.trim() && current.trim() !== next.trim() && !overwrite.has(field)) {
      conflicts.push({ field, existing: current });
    }
  }
  for (const field of ["tags", "searchKeywords", "bulletFeatures"] as const) {
    const next = fields[field];
    if (next === undefined) continue;
    const current = strings(product[field]);
    if (current.length > 0 && !isSuperset(next, current) && !overwrite.has(field)) {
      conflicts.push({ field, existing: current });
    }
  }

  const images = fields.imageAlts?.length
    ? await db.select().from(productImages).where(eq(productImages.productId, productId))
    : [];
  const imageById = new Map(images.map((image) => [image.id, image]));
  for (const entry of fields.imageAlts ?? []) {
    const image = imageById.get(entry.imageId);
    if (!image) throw new SeoPulseError("One of those photographs does not belong to this product.", 400);
    if (image.altText.trim() && image.altText.trim() !== entry.altText && !overwrite.has("imageAlts")) {
      conflicts.push({ field: "imageAlts", existing: image.altText });
      break;
    }
  }

  if (conflicts.length > 0) {
    throw new SeoPulseError(
      "Some fields already have values. Choose Replace for each one you want SEO Pulse to overwrite.",
      409,
      { conflicts: conflicts.map((conflict) => conflict.field) },
    );
  }

  const applied: ApplyField[] = [];
  const skipped: string[] = [];

  if (fields.slug !== undefined && fields.slug !== product.slug && (await slugTaken(fields.slug, productId))) {
    throw new SeoPulseError(`The address /products/${fields.slug} is already used by another product.`, 409);
  }

  const patch: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    if (fields[field] === undefined) continue;
    patch[field] = field === "descriptionHtml" ? sanitizeDescriptionHtml(fields[field] as string) : fields[field];
  }
  if (fields.tags !== undefined) patch.tags = fields.tags;
  if (fields.searchKeywords !== undefined) patch.searchKeywords = fields.searchKeywords;
  if (fields.bulletFeatures !== undefined) patch.bulletFeatures = fields.bulletFeatures;

  if (Object.keys(patch).length > 0) {
    const parsed = productPatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new SeoPulseError(parsed.error.issues[0]?.message ?? "Check the values.", 400);
    }
    await updateProduct(staff, productId, parsed.data);
    applied.push(...(Object.keys(patch) as ApplyField[]));
  }

  if (fields.imageAlts?.length) {
    for (const entry of fields.imageAlts) {
      await updateProductImageAltText(staff, entry.imageId, entry.altText);
    }
    applied.push("imageAlts");
  }

  if (fields.synonyms?.length) {
    let created = 0;
    for (const entry of fields.synonyms) {
      const parsed = synonymInputSchema.safeParse({
        term: normalizeKeyword(entry.term),
        synonyms: entry.synonyms.map(normalizeKeyword),
        bidirectional: true,
      });
      if (!parsed.success || parsed.data.synonyms.length === 0) {
        skipped.push(`Synonym "${entry.term}": ${parsed.success ? "no synonyms left" : parsed.error.issues[0]?.message}`);
        continue;
      }
      try {
        await createSynonym(staff, parsed.data);
        created += 1;
      } catch (error) {
        // An existing entry is never edited from here — that stays a decision
        // made on the Search screen.
        skipped.push(`Synonym "${entry.term}": ${errorText(error)}`);
      }
    }
    if (created > 0) applied.push("synonyms");
  }

  if (applied.length === 0 && skipped.length === 0) {
    throw new SeoPulseError("Choose at least one recommendation to apply.", 400);
  }

  const appliedFields = [...new Set([...strings(run.run.appliedFields), ...applied])];
  await db
    .update(seoResearchRuns)
    .set({ appliedFields, appliedAt: new Date(), appliedBy: staff.id })
    .where(eq(seoResearchRuns.id, payload.runId));

  await recordAudit({
    actorUserId: staff.id,
    action: "seo_pulse.applied",
    entityType: "product",
    entityId: productId,
    after: { runId: payload.runId, applied, replaced: [...overwrite], skipped },
  });

  return { applied, skipped };
}
