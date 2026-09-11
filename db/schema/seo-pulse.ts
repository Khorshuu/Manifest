import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { users } from "./users";

export const SEO_RESEARCH_STATUSES = ["running", "completed", "failed"] as const;
export type SeoResearchStatus = (typeof SEO_RESEARCH_STATUSES)[number];

/**
 * One SEO Pulse run for one product (DECISIONS.md D-038, migration 0019).
 *
 * A run is never updated after it completes except to record that staff
 * applied some of it: regenerating inserts a new version, so earlier research
 * is never lost. The research and the analysis are kept apart on purpose —
 * `research` holds only what a data source returned, with its source and date,
 * and `analysis` holds what SEO Pulse recommends from it. Nothing in
 * `research` is ever produced by the analysis step.
 */
export const seoResearchRuns = pgTable(
  "seo_research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    /** 1, 2, 3… per product, in the order the runs were started. */
    version: integer("version").notNull(),
    status: text("status").notNull().default("running"),
    /** The client's key for one click, so a retried request cannot run twice. */
    requestKey: text("request_key").notNull(),
    initiatedBy: uuid("initiated_by").references(() => users.id),
    /** SeoPulseInput — the product as it stood when the run began. */
    inputSnapshot: jsonb("input_snapshot").notNull(),
    /** A hash of the snapshot: equal hashes mean the product has not changed. */
    inputHash: text("input_hash").notNull(),
    /** SeoResearchData — what the data providers returned. */
    research: jsonb("research"),
    /** SeoAnalysis — the recommendations. */
    analysis: jsonb("analysis"),
    seoScore: smallint("seo_score"),
    searchScore: smallint("search_score"),
    /** ProviderUsage[] — which providers ran, requests made, reported cost. */
    providerUsage: jsonb("provider_usage"),
    pulseVersion: text("pulse_version").notNull(),
    error: text("error"),
    /** string[] — the product fields staff applied from this run. */
    appliedFields: jsonb("applied_fields"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: uuid("applied_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "seo_research_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    unique("seo_research_runs_version_unique").on(table.productId, table.version),
    unique("seo_research_runs_request_key_unique").on(table.requestKey),
    index("seo_research_runs_product_idx").on(table.productId, table.createdAt),
    index("seo_research_runs_created_idx").on(table.createdAt),
  ],
);
