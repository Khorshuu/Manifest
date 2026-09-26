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
import { enqueueJob } from "@/lib/jobs/runner";
import type { Executor } from "@/lib/pkb/common";
import { groundedKnowledge } from "@/lib/pkb/publish";
import { beginListingChange } from "@/lib/pkb/sync";
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
  measurementRows,
  specificationRows,
  identifierStatus,
  knowledgeSufficiency,
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
import { contentOwnership, type ContentOwner } from "@/lib/seo/fields";
import { searchReadiness, seoReadiness } from "@/lib/seo/readiness";
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

  const [images, allCategories, variants, [rating], definitions, knowledge, owners] = await Promise.all([
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
    /*
     * The knowledge base's own account of this product (D-113).
     *
     * SEO Pulse used to read the listing's columns and nothing else, so
     * everything the enrichment pipeline had established — a verified GTIN, a
     * material accepted from the manufacturer's documentation, a measurement
     * taken from a specification sheet — was invisible to the generator that
     * was supposed to describe the product. It reads it here, through the same
     * publication rule the storefront's structured data uses, so nothing
     * unverified can reach a factual generation context.
     */
    groundedKnowledge(product.pkbProductId),
    // Which content is SEO Pulse's own unedited wording (D-120).
    contentOwnership(db, productId, ["descriptionHtml", "bulletFeatures"] as const),
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
      // The unit is added only to a value that does not already spell one:
      // a figure copied from a manufacturer's page usually carries its own
      // ("665g"), and appending the definition's unit prints "665g g".
      const withUnit =
        definition.unit && !/\p{L}/u.test(shown) ? `${shown} ${definition.unit}` : shown;
      return shown.trim() ? [{ label: definition.name, value: withUnit }] : [];
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
    knowledge,
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
    pulseWritten: {
      description: owners.get("descriptionHtml") === "seo_pulse",
      bulletFeatures: owners.get("bulletFeatures") === "seo_pulse",
    },
    specifications,
    measurements: Array.isArray(product.measurements)
      ? (product.measurements as { label: string; value: string }[])
      : [],
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
    specifications: specificationRows(input),
    measurements: measurementRows(input),
    contentGaps: contentGaps(input),
    identifiers: identifierStatus(input),
    schemaReadiness: schemaReadiness(input),
    competitorObservations: competitorObservations(serp),
    readiness: { seo: seoReadiness(input), search: searchReadiness(input) },
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
  /** Legacy weighted scores, on runs recorded before Stage 4 (finding F13). */
  seoScore: number | null;
  searchScore: number | null;
  /** How many measurable checks passed, out of how many were checked. */
  seoChecks: { passed: number; total: number } | null;
  searchChecks: { passed: number; total: number } | null;
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
    seoChecks:
      run.seoChecksTotal === null || run.seoChecksPassed === null
        ? null
        : { passed: run.seoChecksPassed, total: run.seoChecksTotal },
    searchChecks:
      run.searchChecksTotal === null || run.searchChecksPassed === null
        ? null
        : { passed: run.searchChecksPassed, total: run.searchChecksTotal },
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

  /*
   * Research that calls an external service does not run inside the admin's
   * request: a slow or rate-limited provider would hold the request open and
   * time it out (finding F4). The run row exists and says `running`; the job
   * finishes it, and the screen shows the result when it polls. With no
   * external provider configured the rules generator is fast and local, so it
   * still runs here and the answer is immediate.
   */
  if (usesExternalProviders()) {
    await enqueueJob({
      kind: "seo.research_product",
      payload: { runId: row.id },
      dedupeKey: `seo.research:${row.id}`,
    });
    await recordAudit({
      actorUserId: staff.id,
      action: "seo_pulse.researched",
      entityType: "product",
      entityId: productId,
      after: { runId: row.id, version: row.version, fresh: options.fresh, queued: true },
    });
    const queued = await findRun(eq(seoResearchRuns.id, row.id));
    return { run: toDetail(queued as RunRow), reused: false };
  }

  try {
    const { research, analysis, usage } = await executeResearch(input);
    await db
      .update(seoResearchRuns)
      .set({
        status: "completed",
        research,
        analysis,
        providerUsage: usage,
        // Counted checks, not a weighted score (finding F13).
        seoChecksPassed: analysis.readiness.seo.passed,
        seoChecksTotal: analysis.readiness.seo.checks.length,
        searchChecksPassed: analysis.readiness.search.passed,
        searchChecksTotal: analysis.readiness.search.checks.length,
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

/** Whether a run would call out to a paid or remote service. */
export function usesExternalProviders(): boolean {
  const config = getSeoPulseConfig();
  const ai = config.SEO_PULSE_AI_PROVIDER === "anthropic" && Boolean(config.ANTHROPIC_API_KEY);
  return ai || getSeoDataProvider() !== null;
}

/**
 * Finishes a queued run. Idempotent: a run that is no longer `running` is
 * left alone, so a retried job cannot overwrite a completed analysis.
 */
export async function completeQueuedResearch(runId: string): Promise<{ status: string }> {
  const existing = await findRun(eq(seoResearchRuns.id, runId));
  if (!existing) return { status: "missing" };
  if (existing.run.status !== "running") return { status: existing.run.status };

  const input = await loadPulseInput(existing.run.productId);
  if (!input) {
    await db
      .update(seoResearchRuns)
      .set({ status: "failed", error: "The product was removed before research finished.", completedAt: new Date() })
      .where(eq(seoResearchRuns.id, runId));
    return { status: "failed" };
  }

  try {
    const { research, analysis, usage } = await executeResearch(input);
    await db
      .update(seoResearchRuns)
      .set({
        status: "completed",
        research,
        analysis,
        providerUsage: usage,
        seoChecksPassed: analysis.readiness.seo.passed,
        seoChecksTotal: analysis.readiness.seo.checks.length,
        searchChecksPassed: analysis.readiness.search.passed,
        searchChecksTotal: analysis.readiness.search.checks.length,
        completedAt: new Date(),
      })
      .where(eq(seoResearchRuns.id, runId));
    return { status: "completed" };
  } catch (error) {
    await db
      .update(seoResearchRuns)
      .set({ status: "failed", error: errorText(error), completedAt: new Date() })
      .where(eq(seoResearchRuns.id, runId));
    throw error;
  }
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
  /** The listing's readiness as it stands now, independent of any run. */
  current: { seo: ReturnType<typeof seoReadiness>; search: ReturnType<typeof searchReadiness> };
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
    current: { seo: seoReadiness(input), search: searchReadiness(input) },
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
  /**
   * Generated text waiting for review. With an AI generator configured,
   * nothing it wrote is written to the listing by Fill: the recommendations
   * are returned here and applied field by field (finding F2, D-075).
   */
  proposed: { field: ApplyField; label: string; preview: string }[];
  /** Facts SEO Pulse cannot know; the admin should add them. */
  needsInput: string[];
  /** Photographs whose alt text SEO Pulse cannot write without seeing them. */
  imagesNeedReview: number;
  /** True when research is running as a job and there is nothing to fill yet. */
  queued?: boolean;
  /**
   * Set when too little is established about the product to write customer
   * content from (D-119). The description and key features were then left
   * alone; search wording derived from the product's name may still have been
   * filled, and is not a researched listing.
   */
  needsKnowledge?: { message: string; missing: string[] } | null;
  /**
   * Kept fields the research would now word differently (D-120). Never
   * written by Fill; the editor offers them in each field's own section.
   */
  newerVersions?: { field: RecommendedField; label: string; owner: ContentOwner }[];
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
  if (!analysis) {
    // Research is running as a job (finding F4). Nothing is written from an
    // unfinished run; the screen asks again when it completes.
    if (run.status === "running") {
      return {
        runId: run.id,
        reused,
        generator: "Research is still running",
        filled: [],
        kept: [],
        proposed: [],
        needsInput: [],
        imagesNeedReview: 0,
        queued: true,
      };
    }
    throw new SeoPulseError("SEO Pulse could not analyse this product. Review its information.", 502);
  }

  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw new SeoPulseError("That product was not found.", 404);

  const fields: SeoPulseApplyPayload["fields"] = {};
  const filled: string[] = [];
  const kept: string[] = [];
  const proposed: FillResult["proposed"] = [];
  const empty = (value: string | null) => !value || !value.trim();

  /*
   * A generator that writes prose is not evidence, so its words are never
   * written into a listing that may already be published without someone
   * reading them first (finding F2). With the rules generator, Fill still
   * fills: every value it produces is derived from facts the listing records.
   */
  const review = analysis.generator.kind === "ai";
  const preview = (value: unknown) => {
    const text = Array.isArray(value) ? value.join(" · ") : String(value ?? "");
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  };
  const offer = (field: ApplyField, label: string, value: unknown) => {
    if (review) {
      proposed.push({ field, label, preview: preview(value) });
      return false;
    }
    return true;
  };

  const text = (
    key: "seoFocusKeyword" | "seoMetaTitle" | "seoMetaDescription" | "descriptionHtml",
    value: string | null | undefined,
    label: string,
  ) => {
    if (!value) return;
    if (!empty(product[key])) {
      kept.push(label);
      return;
    }
    const next = key === "descriptionHtml" ? sanitizeDescriptionHtml(value) : value;
    if (!offer(key, label, next)) return;
    fields[key] = next;
    filled.push(label);
  };

  /*
   * Customer content only from enough established fact (D-115, D-119).
   *
   * Product preparation already refused to call such a product ready; Fill
   * used not to ask, and wrote a description made of the product's name and
   * the shop's delivery terms into a listing nobody had researched. Now the
   * description and the key features are left exactly as they are — empty,
   * or whatever staff wrote — until there is something true to say. Search
   * wording derived from the name and category is still offered: it describes
   * how people look for the product, not the product.
   */
  const input = await loadPulseInput(productId);
  const sufficiency = input ? knowledgeSufficiency(input) : null;
  const needsKnowledge =
    sufficiency && !sufficiency.sufficient
      ? {
          message: "SeoPulse needs more verified product information before it can prepare customer content.",
          missing: sufficiency.missing,
        }
      : null;

  text("seoFocusKeyword", analysis.primaryKeyword.keyword, "Focus keyword");
  // A search snippet waits for knowledge like the description does (D-123).
  if (!needsKnowledge) text("seoMetaTitle", analysis.seoTitle.recommended, "SEO title");
  if (!needsKnowledge) text("seoMetaDescription", analysis.metaDescription.recommended, "Meta description");
  if (!needsKnowledge) text("descriptionHtml", analysis.description.suggestedHtml, "Description");

  const features = needsKnowledge ? [] : (analysis.keyFeatures ?? []);
  if (features.length > 0) {
    if (strings(product.bulletFeatures).length > 0) {
      kept.push("Key features");
    } else if (offer("bulletFeatures", "Key features", features)) {
      fields.bulletFeatures = features;
      filled.push("Key features");
    }
  }

  /*
   * The specification and measurement tables are not written. They would
   * only rearrange facts the listing already records — brand, details, the
   * category's specifications — and the product page already shows those, so
   * copying them into `spec_table` showed each twice and kept two copies of
   * one fact (KNOWLEDGE_PLATFORM.md finding F1, D-066). The facts live in the
   * knowledge base; the analysis still lists them in the report.
   */

  const tags = strings(product.tags);
  const nextTags = mergeTerms(tags, analysis.tags, 30, 40);
  if (nextTags.length > tags.length && offer("tags", "Tags", analysis.tags)) {
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
  if (nextKeywords.length > keywords.length && offer("searchKeywords", "Search terms", analysis.searchAliases)) {
    fields.searchKeywords = nextKeywords;
    filled.push(`Search terms (+${nextKeywords.length - keywords.length})`);
  }

  if (Object.keys(fields).length > 0) {
    await applySeoPulse(staff, productId, { runId: run.id, fields, overwrite: [] });
  }

  /*
   * Fields Fill kept because they already held something, where the research
   * would now say something different (D-120). Fill never replaces them; the
   * editor offers the new version in the field's own section, as Regenerate
   * when the old wording was SEO Pulse's and as a reviewed Replace when it
   * was a person's.
   */
  const recommendations = await seoPulseRecommendations(staff, productId);
  const newerVersions = (recommendations?.runId === run.id ? recommendations.fields : [])
    .filter((entry) => entry.owner !== "empty")
    .map((entry) => ({ field: entry.field, label: entry.label, owner: entry.owner }));

  return {
    runId: run.id,
    reused,
    generator: analysis.generator.label,
    filled,
    kept,
    proposed,
    needsInput: analysis.contentGaps.filter((gap) => FACT_GAPS.has(gap.key)).map((gap) => gap.label),
    imagesNeedReview: analysis.imageAlts.filter((image) => image.needsReview).length,
    queued: false,
    needsKnowledge,
    newerVersions,
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
 *
 * All of the writes — the product, each alt text, each synonym, the run marker
 * and the audit entry — happen in one transaction, so a failure part-way
 * leaves no half-applied listing (finding F3, D-075).
 */
export async function applySeoPulse(
  actor: SessionUser | null,
  productId: string,
  payload: SeoPulseApplyPayload,
  options: {
    /** What the change history says happened. */
    reason?: string;
    /**
     * Runs inside the transaction, after the listing lock and before anything
     * is written, so a check it makes cannot go stale before the write
     * (D-120: regenerating refuses a field someone edited a moment ago).
     */
    guard?: (tx: Executor) => Promise<void>;
  } = {},
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

  /*
   * What the apply would overwrite, read through whichever handle is given.
   *
   * It is asked twice on purpose. Once before the transaction, so a staff
   * member gets the "choose Replace" answer without a lock being taken; and
   * again inside it, after the listing's knowledge lock, because the first
   * answer is already out of date by the time the write happens. Two people
   * applying two different runs at the same moment would otherwise both pass
   * the check and the second would replace the first's wording without anybody
   * confirming it — the same shape of stale read as finding F8, on the guard
   * rather than on the patch.
   */
  async function conflictsAgainst(executor: Executor) {
    const [current] = await executor.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!current) throw new SeoPulseError("That product was not found.", 404);

    const found: { field: ApplyField; existing: unknown }[] = [];

    for (const field of TEXT_FIELDS) {
      const next = fields[field];
      if (next === undefined) continue;
      const existing = (current[field] as string | null) ?? "";
      if (existing.trim() && existing.trim() !== next.trim() && !overwrite.has(field)) {
        found.push({ field, existing });
      }
    }
    for (const field of ["tags", "searchKeywords", "bulletFeatures"] as const) {
      const next = fields[field];
      if (next === undefined) continue;
      const existing = strings(current[field]);
      if (existing.length > 0 && !isSuperset(next, existing) && !overwrite.has(field)) {
        found.push({ field, existing });
      }
    }

    /*
     * The specification and measurement tables are no longer written from here
     * at all. Their facts belong to the knowledge base, which mirrors them into
     * the listing with provenance; writing them from an analysis would create a
     * second, unattributed copy (finding F1, D-070).
     */

    const images: (typeof productImages.$inferSelect)[] = fields.imageAlts?.length
      ? await executor.select().from(productImages).where(eq(productImages.productId, productId))
      : [];
    const imageById = new Map(images.map((image) => [image.id, image]));
    for (const entry of fields.imageAlts ?? []) {
      const image = imageById.get(entry.imageId);
      if (!image) throw new SeoPulseError("One of those photographs does not belong to this product.", 400);
      if (image.altText.trim() && image.altText.trim() !== entry.altText && !overwrite.has("imageAlts")) {
        found.push({ field: "imageAlts", existing: image.altText });
        break;
      }
    }

    return { product: current, conflicts: found };
  }

  function refuse(conflicts: { field: ApplyField }[]): never {
    throw new SeoPulseError(
      "Some fields already have values. Choose Replace for each one you want SEO Pulse to overwrite.",
      409,
      { conflicts: conflicts.map((conflict) => conflict.field) },
    );
  }

  const { product, conflicts } = await conflictsAgainst(db);
  if (conflicts.length > 0) refuse(conflicts);

  const applied: ApplyField[] = [];
  const skipped: string[] = [];

  if (fields.slug !== undefined && fields.slug !== product.slug && (await slugTaken(fields.slug, productId))) {
    throw new SeoPulseError(`The address /products/${fields.slug} is already used by another product.`, 409);
  }

  return db.transaction(async (tx) => applyInside(tx));

  async function applyInside(tx: Executor) {
  /*
   * The lock first, then the re-check.
   *
   * Re-reading inside the transaction is not enough on its own: both callers
   * read before either had the lock, so both still saw an empty field.
   * `beginListingChange` is the same lock `updateProduct` takes a moment later
   * — taking it twice in one transaction costs nothing — and it is what makes
   * the second caller's read happen after the first has committed.
   */
  await beginListingChange(tx, productId);
  const settled = await conflictsAgainst(tx);
  if (settled.conflicts.length > 0) refuse(settled.conflicts);
  if (options.guard) await options.guard(tx);


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
    await updateProduct(staff, productId, parsed.data, {
      executor: tx,
      // Accepted by a person, from this run: the field becomes theirs, and a
      // locked field refuses the apply rather than being overwritten (D-077).
      fieldWrites: { origin: "accepted", reason: options.reason ?? "Applied from SEO Pulse", runId: payload.runId },
    });
    applied.push(...(Object.keys(patch) as ApplyField[]));
  }

  if (fields.imageAlts?.length) {
    for (const entry of fields.imageAlts) {
      await updateProductImageAltText(staff, entry.imageId, entry.altText, { executor: tx });
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
        await createSynonym(staff, parsed.data, { executor: tx });
        created += 1;
      } catch (error) {
        // An existing entry is never edited from here — that stays a decision
        // made on the Search screen. A refusal inside a transaction would
        // poison it, so the term is checked before the insert is attempted.
        skipped.push(`Synonym "${entry.term}": ${errorText(error)}`);
      }
    }
    if (created > 0) applied.push("synonyms");
  }

  if (applied.length === 0 && skipped.length === 0) {
    throw new SeoPulseError("Choose at least one recommendation to apply.", 400);
  }

  const appliedFields = [...new Set([...strings(run!.run.appliedFields), ...applied])];
  await tx
    .update(seoResearchRuns)
    .set({ appliedFields, appliedAt: new Date(), appliedBy: staff.id })
    .where(eq(seoResearchRuns.id, payload.runId));

  await recordAudit(
    {
      actorUserId: staff.id,
      action: "seo_pulse.applied",
      entityType: "product",
      entityId: productId,
      after: { runId: payload.runId, applied, replaced: [...overwrite], skipped, ...(options.reason ? { reason: options.reason } : {}) },
    },
    tx,
  );

  return { applied, skipped };
  }
}

// ------------------------------------------------------- recommendations

/**
 * The customer-facing wording SEO Pulse can offer to replace (D-120). These
 * are the fields a person reads and may have rewritten; tags, search terms
 * and photo descriptions keep their own apply rules.
 */
export const RECOMMENDED_FIELDS = [
  "descriptionHtml",
  "bulletFeatures",
  "seoMetaTitle",
  "seoMetaDescription",
  "seoFocusKeyword",
] as const;
export type RecommendedField = (typeof RECOMMENDED_FIELDS)[number];

const RECOMMENDED_LABELS: Record<RecommendedField, string> = {
  descriptionHtml: "Description",
  bulletFeatures: "Key features",
  seoMetaTitle: "SEO title",
  seoMetaDescription: "Meta description",
  seoFocusKeyword: "Focus keyword",
};

export type FieldRecommendation = {
  field: RecommendedField;
  label: string;
  /** What the listing holds now. */
  current: string | string[] | null;
  /** What the latest research would write. */
  proposed: string | string[];
  /** Who owns the current value, which decides what the editor offers. */
  owner: ContentOwner;
};

export type SeoPulseRecommendations = {
  runId: string;
  preparedAt: string;
  /** True when the product changed after this research was done. */
  stale: boolean;
  /** Set when too little is established to write customer content. */
  needsKnowledge: { message: string; missing: string[] } | null;
  /** Only fields where the research would write something different. */
  fields: FieldRecommendation[];
};

type ProposedValues = Partial<Record<RecommendedField, string | string[]>>;

/** What a run would write into each field, with customer content only from sufficient knowledge. */
function proposedValues(analysis: SeoAnalysis, sufficient: boolean): ProposedValues {
  const values: ProposedValues = {
    seoFocusKeyword: analysis.primaryKeyword.keyword,
  };
  /*
   * The SEO title and meta description are what a search result says about
   * the product, so they wait for the same knowledge as the description
   * (D-123). Offering "<name> – Price in Bangladesh" for a product nobody has
   * researched filled the field with commerce copy that looked finished. The
   * focus keyword is only how people search for the name, and is still offered.
   */
  if (sufficient && analysis.seoTitle.recommended.trim()) values.seoMetaTitle = analysis.seoTitle.recommended;
  if (sufficient && analysis.metaDescription.recommended.trim()) values.seoMetaDescription = analysis.metaDescription.recommended;
  if (sufficient && analysis.description.suggestedHtml) {
    values.descriptionHtml = sanitizeDescriptionHtml(analysis.description.suggestedHtml);
  }
  if (sufficient && (analysis.keyFeatures ?? []).length > 0) values.bulletFeatures = analysis.keyFeatures;
  return values;
}

function sameContent(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const list = (value: unknown) => JSON.stringify(strings(value).map((entry) => entry.trim()));
    return list(a) === list(b);
  }
  return String(a ?? "").trim() === String(b ?? "").trim();
}

async function latestCompletedRun(productId: string): Promise<RunRow | null> {
  const [row] = await db
    .select(runColumns)
    .from(seoResearchRuns)
    .leftJoin(users, eq(users.id, seoResearchRuns.initiatedBy))
    .where(and(eq(seoResearchRuns.productId, productId), eq(seoResearchRuns.status, "completed")))
    .orderBy(desc(seoResearchRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The latest research's wording beside what the listing holds, field by
 * field, with who owns each current value (D-120). Read-only: showing a
 * recommendation never writes it. Preparation prepares these; the editor
 * shows them in Product content and SEO & search.
 */
export async function seoPulseRecommendations(
  actor: SessionUser | null,
  productId: string,
): Promise<SeoPulseRecommendations | null> {
  requirePermission(actor, "catalog.manage");
  const run = await latestCompletedRun(productId);
  const analysis = run?.run.analysis as SeoAnalysis | null | undefined;
  if (!run || !analysis) return null;

  const input = await loadPulseInput(productId);
  if (!input) return null;
  const sufficiency = knowledgeSufficiency(input);
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  const owners = await contentOwnership(db, productId, RECOMMENDED_FIELDS);
  const proposed = proposedValues(analysis, sufficiency.sufficient);

  const fields: FieldRecommendation[] = [];
  for (const field of RECOMMENDED_FIELDS) {
    const next = proposed[field];
    if (next === undefined) continue;
    const raw = (product as Record<string, unknown>)[field];
    const current = Array.isArray(raw) ? strings(raw) : typeof raw === "string" ? raw : null;
    if (sameContent(current, next)) continue;
    fields.push({ field, label: RECOMMENDED_LABELS[field], current, proposed: next, owner: owners.get(field) ?? "staff" });
  }

  return {
    runId: run.run.id,
    preparedAt: (run.run.completedAt ?? run.run.createdAt).toISOString(),
    stale: run.run.inputHash !== hashInput(input),
    needsKnowledge: sufficiency.sufficient
      ? null
      : {
          message: "SeoPulse needs more verified product information before it can prepare customer content.",
          missing: sufficiency.missing,
        },
    fields,
  };
}

/**
 * Writes the latest research's wording into the fields staff chose (D-120).
 *
 * The values come from the run on the server, never from the request. A field
 * SEO Pulse wrote and nobody has changed since may be regenerated with a
 * click. A field a person wrote, or edited after SEO Pulse, is replaced only
 * when the request says so in `replaceStaff` — the editor asks for that only
 * after showing both versions. A locked field is never replaced here.
 *
 * Ownership is checked twice: before, to answer quickly, and again inside the
 * apply transaction after the listing lock, so an edit saved a moment
 * earlier is not replaced by a click made against the older value. The
 * change history records the replacement, with its before and after.
 */
export async function regenerateWithSeoPulse(
  actor: SessionUser | null,
  productId: string,
  request: { runId: string; fields: RecommendedField[]; replaceStaff: boolean },
): Promise<{ applied: ApplyField[] }> {
  const staff = requirePermission(actor, "catalog.manage");
  const wanted = [...new Set(request.fields)];
  if (wanted.length === 0) throw new SeoPulseError("Choose at least one field to regenerate.", 400);

  const run = await findRun(eq(seoResearchRuns.id, request.runId));
  if (!run || run.run.productId !== productId) {
    throw new SeoPulseError("That research run was not found for this product.", 404);
  }
  const analysis = run.run.analysis as SeoAnalysis | null;
  if (run.run.status !== "completed" || !analysis) {
    throw new SeoPulseError("Only completed research can be applied.", 409);
  }
  const latest = await latestCompletedRun(productId);
  if (latest && latest.run.id !== run.run.id) {
    throw new SeoPulseError("Newer SEO Pulse research exists for this product. Review it before replacing anything.", 409);
  }

  const input = await loadPulseInput(productId);
  if (!input) throw new SeoPulseError("That product was not found.", 404);
  const sufficiency = knowledgeSufficiency(input);
  const proposed = proposedValues(analysis, sufficiency.sufficient);

  const fields: SeoPulseApplyPayload["fields"] = {};
  for (const field of wanted) {
    const value = proposed[field];
    if (value === undefined) {
      throw new SeoPulseError(
        field === "descriptionHtml" || field === "bulletFeatures"
          ? "SeoPulse needs more verified product information before it can prepare customer content."
          : `SEO Pulse has no ${RECOMMENDED_LABELS[field].toLowerCase()} to offer.`,
        409,
      );
    }
    (fields as Record<string, unknown>)[field] = value;
  }

  const allowed: ContentOwner[] = request.replaceStaff ? ["empty", "seo_pulse", "staff"] : ["empty", "seo_pulse"];
  const check = async (executor: Executor) => {
    const owners = await contentOwnership(executor, productId, wanted);
    for (const field of wanted) {
      const owner = owners.get(field) ?? "staff";
      if (owner === "locked") {
        throw new SeoPulseError(`${RECOMMENDED_LABELS[field]} is locked. Unlock it first if you want SEO Pulse to change it.`, 409);
      }
      if (!allowed.includes(owner)) {
        throw new SeoPulseError(
          `${RECOMMENDED_LABELS[field]} was written or edited by staff. Review the SeoPulse version and choose Replace to use it.`,
          409,
          { staffOwned: [field] },
        );
      }
    }
  };
  await check(db);

  const { applied } = await applySeoPulse(
    staff,
    productId,
    { runId: run.run.id, fields, overwrite: wanted },
    {
      reason: request.replaceStaff ? "Replaced with the SEO Pulse version by staff" : "Regenerated with SEO Pulse",
      guard: check,
    },
  );
  return { applied };
}

// ------------------------------------------------------- prepared content

export type PreparedContentResult = {
  /** Labels of fields that were empty and now hold SeoPulse's wording. */
  applied: string[];
  /** Labels of fields that held SeoPulse's own unedited wording, now refreshed. */
  refreshed: string[];
  /** Labels of fields a person wrote, left alone although SeoPulse has another version. */
  kept: string[];
  /**
   * Labels of empty fields left as recommendations because the wording came
   * from a generator whose prose is read before it is used (finding F2).
   */
  review: string[];
  /** True when newer research exists; nothing was written from this run. */
  superseded: boolean;
  /** True when too little is established to write customer content. */
  needsKnowledge: boolean;
};

/**
 * Writes a preparation run's wording into the listing where that is safe
 * (D-122) — the step that makes "Prepare with SeoPulse" one action instead of
 * research followed by a separate Fill.
 *
 * What it may touch is decided by who owns each field (D-120), read again
 * under the listing lock before anything is written:
 *
 *  - **empty** — filled with the grounded recommendation.
 *  - **seo_pulse** — SeoPulse's own unedited wording, refreshed. Somebody
 *    explicitly asked for this product to be prepared, and nobody's writing
 *    is lost: the history keeps the previous version.
 *  - **staff** — never written. Reported, so the editor can offer Keep,
 *    Review or Replace in the field's own section.
 *  - **locked** — never written, and not offered.
 *
 * Tags and search terms are lists: they are added to only when they are empty
 * or SeoPulse's own, and an addition never drops an entry.
 *
 * Customer content is written only from sufficient knowledge (D-115), and
 * prose from an AI generator is left as a recommendation for a person to read
 * rather than written into the listing unseen (finding F2), exactly as Fill
 * treats it. The values come from the stored run, never from a caller.
 */
export async function applyPreparedContent(
  actor: SessionUser | null,
  productId: string,
  runId: string,
): Promise<PreparedContentResult> {
  const staff = requirePermission(actor, "catalog.manage");
  const result: PreparedContentResult = {
    applied: [],
    refreshed: [],
    kept: [],
    review: [],
    superseded: false,
    needsKnowledge: false,
  };

  const run = await findRun(eq(seoResearchRuns.id, runId));
  if (!run || run.run.productId !== productId) {
    throw new SeoPulseError("That research run was not found for this product.", 404);
  }
  const analysis = run.run.analysis as SeoAnalysis | null;
  if (run.run.status !== "completed" || !analysis) {
    throw new SeoPulseError("Only completed research can be applied.", 409);
  }
  const latest = await latestCompletedRun(productId);
  if (latest && latest.run.id !== runId) return { ...result, superseded: true };

  const input = await loadPulseInput(productId);
  if (!input) throw new SeoPulseError("That product was not found.", 404);
  const sufficiency = knowledgeSufficiency(input);
  if (!sufficiency.sufficient) return { ...result, needsKnowledge: true };

  const proposed = proposedValues(analysis, true);
  const listFields = ["tags", "searchKeywords"] as const;
  const owners = await contentOwnership(db, productId, [...RECOMMENDED_FIELDS, ...listFields]);
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw new SeoPulseError("That product was not found.", 404);

  const fields: SeoPulseApplyPayload["fields"] = {};
  const overwrite: RecommendedField[] = [];
  /** The owner each written field had when it was chosen, re-checked under the lock. */
  const expected = new Map<RecommendedField | (typeof listFields)[number], ContentOwner>();
  const reviewFirst = analysis.generator.kind === "ai";

  for (const field of RECOMMENDED_FIELDS) {
    const next = proposed[field];
    if (next === undefined) continue;
    const raw = (product as Record<string, unknown>)[field];
    const current = Array.isArray(raw) ? strings(raw) : typeof raw === "string" ? raw : null;
    if (sameContent(current, next)) continue;
    const owner = owners.get(field) ?? "staff";
    const label = RECOMMENDED_LABELS[field];
    if (owner === "staff") {
      result.kept.push(label);
      continue;
    }
    if (owner === "locked") continue;
    if (reviewFirst) {
      result.review.push(label);
      continue;
    }
    (fields as Record<string, unknown>)[field] = next;
    expected.set(field, owner);
    if (owner === "seo_pulse") {
      overwrite.push(field);
      result.refreshed.push(label);
    } else {
      result.applied.push(label);
    }
  }

  if (!reviewFirst) {
    const additions: Record<(typeof listFields)[number], { terms: string[]; max: number; length: number; label: string }> = {
      tags: { terms: analysis.tags, max: 30, length: 40, label: "Tags" },
      searchKeywords: {
        terms: [
          ...analysis.searchAliases,
          ...analysis.misspellings.map((entry) => entry.term),
          ...analysis.searchPhrases,
          ...analysis.brandVariations,
        ],
        max: 40,
        length: 60,
        label: "Search terms",
      },
    };
    for (const field of listFields) {
      const owner = owners.get(field) ?? "staff";
      if (owner !== "empty" && owner !== "seo_pulse") continue;
      const existing = strings(product[field]);
      const merged = mergeTerms(existing, additions[field].terms, additions[field].max, additions[field].length);
      if (merged.length <= existing.length) continue;
      fields[field] = merged;
      expected.set(field, owner);
      (owner === "empty" ? result.applied : result.refreshed).push(additions[field].label);
    }
  }

  if (expected.size === 0) return result;

  /*
   * Under the listing lock, the owners are read again: a person who saved a
   * field a moment ago owns it now, and this write must not land on it.
   */
  const guard = async (executor: Executor) => {
    const now = await contentOwnership(executor, productId, [...expected.keys()]);
    for (const [field, owner] of expected) {
      if ((now.get(field) ?? "staff") !== owner) {
        throw new SeoPulseError("The listing changed while SeoPulse was preparing it.", 409, { changed: [field] });
      }
    }
  };

  await applySeoPulse(
    staff,
    productId,
    { runId, fields, overwrite },
    { reason: "Prepared with SeoPulse", guard },
  );
  return result;
}
