import { z } from "zod";

/**
 * The shapes SEO Pulse works in (DECISIONS.md D-038).
 *
 * Three families, kept apart on purpose:
 *
 *  - `SeoPulseInput` — the product as it stood when a run began.
 *  - `SeoResearchData` — what a data source returned. Every figure carries its
 *    source and the date it was collected. Nothing here is ever written by the
 *    analysis step, so a number in this object is never an estimate.
 *  - `SeoAnalysis` — what SEO Pulse recommends. Generated, editable, and
 *    labelled with what generated it.
 */

export const PULSE_VERSION = "2.0.0";

/** Research older than this is flagged as possibly outdated. */
export const STALE_AFTER_DAYS = 30;

export const KEYWORD_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
  "product",
  "use_case",
] as const;
export type KeywordIntent = (typeof KEYWORD_INTENTS)[number];

export const INTENT_LABELS: Record<KeywordIntent, string> = {
  informational: "Informational",
  commercial: "Commercial investigation",
  transactional: "Transactional",
  navigational: "Navigational",
  product: "Product-specific",
  use_case: "Use-case",
};

// ---------------------------------------------------------------- input

export type SeoPulseImage = {
  id: string;
  url: string;
  altText: string;
  kind: "gallery" | "lifestyle";
};

export type SeoPulseInput = {
  productId: string;
  title: string;
  slug: string;
  brand: string | null;
  sku: string | null;
  identifierType: string | null;
  identifierValue: string | null;
  categoryId: string;
  /** Root first: ["Audio", "Headphones"]. */
  categoryPath: string[];
  status: string;
  descriptionText: string;
  bulletFeatures: string[];
  specifications: { label: string; value: string }[];
  details: Record<string, string>;
  boxContents: string[];
  warranty: { hasWarranty: boolean; durationMonths: number | null } | null;
  countryOfOrigin: string | null;
  tags: string[];
  searchKeywords: string[];
  searchable: boolean;
  seoFocusKeyword: string | null;
  seoMetaTitle: string | null;
  seoMetaDescription: string | null;
  seoNoIndex: boolean;
  images: SeoPulseImage[];
  hasVideo: boolean;
  variants: {
    label: string;
    priceBdt: number;
    fulfillmentMode: string;
    available: boolean;
    arrivesFrom: string | null;
    arrivesTo: string | null;
  }[];
  reviews: { count: number; average: number | null };
};

// ------------------------------------------------------------- research

export type ProviderStatus = "ok" | "unavailable" | "failed";

export type ProviderUsage = {
  id: string;
  label: string;
  kind: "first_party" | "external_data" | "ai" | "rules";
  status: ProviderStatus;
  message: string | null;
  requests: number;
  /** Only when the provider itself reported it, or tokens were counted. */
  estimatedCostUsd: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  at: string;
};

/** A keyword figure straight from a data source. Null means not provided. */
export type KeywordMetric = {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  competition: string | null;
  cpcUsd: number | null;
  /** Monthly volumes, oldest first, as the source gave them. */
  trend: { month: string; volume: number }[] | null;
  geo: string;
  source: string;
  researchedAt: string;
};

export type SerpSnapshot = {
  keyword: string;
  geo: string;
  source: string;
  researchedAt: string;
  results: {
    position: number;
    title: string;
    url: string;
    domain: string;
    snippet: string | null;
  }[];
  relatedSearches: string[];
  peopleAlsoAsk: string[];
  hasShoppingResults: boolean;
  hasFeaturedSnippet: boolean;
};

/** This shop's own search log — first-party data, not an estimate. */
export type SiteSearchResearch = {
  source: string;
  windowDays: number;
  researchedAt: string;
  matchingQueries: {
    query: string;
    searches: number;
    zeroResultSearches: number;
  }[];
  queriesLeadingHere: { query: string; clicks: number }[];
  correctedTypos: { typed: string; corrected: string; searches: number }[];
  existingSynonyms: { term: string; synonyms: string[] }[];
};

export type SeoResearchData = {
  siteSearch: SiteSearchResearch | null;
  keywordMetrics: KeywordMetric[];
  serp: SerpSnapshot[];
};

// ------------------------------------------------------------- analysis

const text = (max: number) => z.string().trim().min(1).max(max);

export const keywordSchema = z.object({
  keyword: text(80),
  intent: z.enum(KEYWORD_INTENTS),
  relevance: z.enum(["high", "medium", "low"]),
  reason: text(300),
});
export type KeywordRecommendation = z.infer<typeof keywordSchema>;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The generative part of an analysis — what a rules pass or an AI model
 * writes. Strict: an AI response is cleaned and then parsed against this, and
 * anything that fails is discarded rather than saved (lib/seo-pulse/sanitize.ts).
 */
export const generatedSchema = z.object({
  primaryKeyword: keywordSchema,
  secondaryKeywords: z.array(keywordSchema).max(10),
  longTailKeywords: z.array(keywordSchema).max(10),
  synonyms: z.array(text(60)).max(15),
  relatedTerms: z.array(text(60)).max(15),
  searchAliases: z.array(text(60)).max(15),
  misspellings: z
    .array(z.object({ term: text(60), basis: text(200) }))
    .max(10),
  searchPhrases: z.array(text(60)).max(10),
  brandVariations: z.array(text(60)).max(8),
  seoTitle: z.object({
    recommended: text(70),
    alternatives: z.array(text(70)).max(3),
    reason: text(300),
  }),
  metaDescription: z.object({
    recommended: z.string().trim().min(50).max(170),
    reason: text(300),
  }),
  h1: z.object({ recommended: text(200), reason: text(300) }),
  slug: z.object({
    recommended: z.string().regex(SLUG_PATTERN).max(80),
    reason: text(300),
  }),
  description: z.object({
    improvements: z.array(text(300)).max(10),
    suggestedHtml: z.string().trim().max(8000).nullable(),
  }),
  tags: z.array(text(40)).max(12),
  /** Short feature lines for the product page. Empty when nothing is known. */
  keyFeatures: z.array(text(300)).max(10),
  imageAlts: z
    .array(
      z.object({
        imageId: z.string().uuid(),
        altText: text(125),
        title: z.string().trim().max(120).nullable(),
        needsReview: z.boolean(),
        reason: text(300),
      }),
    )
    .max(30),
  faqs: z
    .array(
      z.object({
        question: text(200),
        answer: z.string().trim().max(600).nullable(),
        needsManualAnswer: z.boolean(),
        basis: text(200),
      }),
    )
    .max(8),
  categoryNotes: z.array(text(300)).max(5),
});
export type GeneratedRecommendations = z.infer<typeof generatedSchema>;

export type ScoreCheck = {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  hint: string;
};

export type ScoreResult = { score: number; checks: ScoreCheck[] };

export type SeoAnalysis = GeneratedRecommendations & {
  generator: {
    kind: "ai" | "rules";
    provider: string;
    model: string | null;
    /** The label the interface and the export show beside every recommendation. */
    label: string;
  };
  keywordGroups: Record<KeywordIntent, string[]>;
  slugConflict: boolean;
  imageFilenames: { imageId: string; filename: string }[];
  contentGaps: { key: string; label: string; reason: string }[];
  identifiers: {
    type: string;
    label: string;
    value: string | null;
    status: "present" | "unavailable";
  }[];
  schemaReadiness: {
    field: string;
    status: "ready" | "missing" | "not_applicable";
    note: string;
  }[];
  competitorObservations: { observation: string; basis: string }[];
  scores: { seo: ScoreResult; search: ScoreResult };
};

/** The product fields an apply may write. */
export const APPLY_FIELDS = [
  "seoFocusKeyword",
  "seoMetaTitle",
  "seoMetaDescription",
  "slug",
  "title",
  "descriptionHtml",
  "bulletFeatures",
  "tags",
  "searchKeywords",
  "imageAlts",
  "synonyms",
] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];

export type ProductPulseStatus =
  | "not_researched"
  | "available"
  | "needs_refresh"
  | "applied"
  | "updated";
