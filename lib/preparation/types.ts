import type { PreparationNote, PreparationStage, PreparationStepRecord } from "@/db/schema";

/**
 * The shapes product preparation works in (D-112).
 *
 * The stages are the vocabulary a future staff screen will use. They are
 * deliberately few and deliberately about the product rather than about the
 * machinery: "finding sources" and "waiting for review" are things a person
 * can act on, where "enrichment run 3 queued" is not.
 *
 * A stage is never reported as passed unless the work behind it actually
 * finished. `steps` is the record of that: one entry per step, written when the
 * step completes, which is also what makes a retry skip it.
 */

export type { PreparationNote, PreparationStage, PreparationStepRecord };

/** The steps, in the order the orchestrator runs them. */
export const PREPARATION_STEPS = [
  "identity",
  "sources",
  "enrichment",
  "verification",
  "content",
  "search",
  "page",
] as const;
export type PreparationStep = (typeof PREPARATION_STEPS)[number];

/** The stage a step is reported under while it is being worked on. */
export const STEP_STAGE: Record<PreparationStep, PreparationStage> = {
  identity: "IDENTIFYING",
  sources: "FINDING_SOURCES",
  enrichment: "RESEARCHING",
  verification: "VERIFYING",
  content: "PREPARING_CONTENT",
  search: "PREPARING_SEARCH",
  page: "CHECKING_PAGE",
};

export const FINISHED_STAGES = new Set<PreparationStage>(["READY", "FAILED", "BLOCKED", "CANCELLED"]);

/**
 * Why a run stopped, in words a staff member can act on.
 *
 * The codes are stable so a screen can explain each one its own way; the
 * message and the remedy are written here so the backend never has to hand a
 * stack trace or a database error to an interface.
 */
export const PREPARATION_CODES = {
  IDENTITY_UNRESOLVED: "IDENTITY_UNRESOLVED",
  IDENTITY_AMBIGUOUS: "IDENTITY_AMBIGUOUS",
  NO_SOURCES: "NO_SOURCES",
  AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED: "AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED",
  AUTOMATIC_SOURCE_DISCOVERY_UNAVAILABLE: "AUTOMATIC_SOURCE_DISCOVERY_UNAVAILABLE",
  ENRICHMENT_BLOCKED: "ENRICHMENT_BLOCKED",
  ENRICHMENT_FAILED: "ENRICHMENT_FAILED",
  SOURCE_STORAGE_FAILED: "SOURCE_STORAGE_FAILED",
  SOURCE_IDENTITY_MISMATCH: "SOURCE_IDENTITY_MISMATCH",
  CLAIMS_CONFLICT: "CLAIMS_CONFLICT",
  CLAIMS_WAITING: "CLAIMS_WAITING",
  LABELS_WAITING: "LABELS_WAITING",
  INSUFFICIENT_KNOWLEDGE: "INSUFFICIENT_KNOWLEDGE",
  CONTENT_PROVIDER_UNAVAILABLE: "CONTENT_PROVIDER_UNAVAILABLE",
  CONTENT_FAILED: "CONTENT_FAILED",
  SEARCH_INDEX_LAGGING: "SEARCH_INDEX_LAGGING",
  PRODUCT_REMOVED: "PRODUCT_REMOVED",
  TOO_LONG: "TOO_LONG",
  CANCELLED: "CANCELLED",
} as const;
export type PreparationCode = (typeof PREPARATION_CODES)[keyof typeof PREPARATION_CODES];

/** What a caller gets back. Nothing here exposes an internal error string. */
export type PreparationView = {
  id: string;
  productId: string;
  pkbProductId: string | null;
  stage: PreparationStage;
  /** True while the run is still expected to move on its own. */
  active: boolean;
  steps: PreparationStepRecord[];
  /** What a person has to decide before it can go on. */
  review: PreparationNote[];
  failure: PreparationNote | null;
  providers: { provider: string; status: string; message: string | null }[];
  enrichmentRunId: string | null;
  seoRunId: string | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};
