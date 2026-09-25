import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { pkbEnrichmentRuns, pkbProducts } from "./pkb";
import { seoResearchRuns } from "./seo-pulse";
import { users } from "./users";

/**
 * Product preparation runs (docs/KNOWLEDGE_PLATFORM.md section 3H, D-112).
 *
 * db/migrations/0043_product_preparation.sql is the source of truth: its check
 * constraints hold the stage vocabulary and the rule that a finished run
 * records when it finished. The declarations here let `lib/preparation` read
 * and write the table through Drizzle.
 *
 * The run coordinates existing work and never repeats it: the knowledge sync,
 * the resolution assessment, the enrichment run, the review queue, the SEO
 * Pulse run and the search index all stay where they are. What this row adds
 * is durability — the state survives a closed tab, a worker restart and a
 * retry — and an honest account of which of those steps has actually finished.
 */

/** The stages a future staff screen shows, in the order they are reached. */
export const PREPARATION_STAGES = [
  /** Synchronising the listing's identity and re-assessing which product it is. */
  "IDENTIFYING",
  /** Counting the sources available: registry, staff URLs, documents, provider. */
  "FINDING_SOURCES",
  /** An enrichment run is retrieving and quoting sources. */
  "RESEARCHING",
  /** Reading what the run proposed against the verification policies. */
  "VERIFYING",
  /** Stopped: a person has to decide something before it can go on. */
  "NEEDS_REVIEW",
  /** Generating the listing's content with SEO Pulse. */
  "PREPARING_CONTENT",
  /** Waiting for the search index to catch up with the listing. */
  "PREPARING_SEARCH",
  /** Measuring the page's SEO and search readiness. */
  "CHECKING_PAGE",
  "READY",
  /** Something failed in a way a retry may fix. */
  "FAILED",
  /** Cannot proceed as things stand: no identity, no sources, no knowledge. */
  "BLOCKED",
  "CANCELLED",
] as const;
export type PreparationStage = (typeof PREPARATION_STAGES)[number];

export const PREPARATION_FINISHED_STAGES = ["READY", "FAILED", "BLOCKED", "CANCELLED"] as const;

/** One step of the sequence, recorded once it has genuinely completed. */
export type PreparationStepRecord = {
  key: string;
  state: "done" | "skipped" | "degraded";
  detail: string;
  at: string;
};

/** Something a person has to decide. Never a stack trace, never a raw error. */
export type PreparationNote = {
  code: string;
  message: string;
  /** What the person can do about it, in a sentence. */
  remedy: string;
  /**
   * For a source that disagrees with the product: what is recorded, what the
   * page says, and where the page is — so the person can see the difference
   * rather than take it on trust. Identifiers only; never a stored value.
   */
  comparison?: {
    url: string | null;
    recorded: { label: string; values: string[] }[];
    found: { label: string; values: string[] }[];
  };
};

export const productPreparationRuns = pgTable(
  "product_preparation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    pkbProductId: uuid("pkb_product_id").references(() => pkbProducts.id, { onDelete: "set null" }),
    stage: text("stage").$type<PreparationStage>().notNull().default("IDENTIFYING"),
    requestKey: text("request_key").notNull().unique(),
    requestedBy: uuid("requested_by").references(() => users.id),
    enrichmentRunId: uuid("enrichment_run_id").references(() => pkbEnrichmentRuns.id, { onDelete: "set null" }),
    seoRunId: uuid("seo_run_id").references(() => seoResearchRuns.id, { onDelete: "set null" }),
    steps: jsonb("steps").$type<PreparationStepRecord[]>().notNull().default([]),
    review: jsonb("review").$type<PreparationNote[]>().notNull().default([]),
    failure: jsonb("failure").$type<PreparationNote | null>(),
    providers: jsonb("providers").$type<{ provider: string; status: string; message: string | null }[]>().notNull().default([]),
    ticks: integer("ticks").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("product_preparation_product_idx").on(table.productId, table.createdAt)],
);

export type ProductPreparationRun = typeof productPreparationRuns.$inferSelect;
