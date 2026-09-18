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
import { categories, products } from "./catalog";
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
    /** Legacy weighted scores (finding F13): not written from Stage 4 on. */
    seoScore: smallint("seo_score"),
    searchScore: smallint("search_score"),
    /** Measurable checks: how many passed out of how many were checked. */
    seoChecksPassed: smallint("seo_checks_passed"),
    seoChecksTotal: smallint("seo_checks_total"),
    searchChecksPassed: smallint("search_checks_passed"),
    searchChecksTotal: smallint("search_checks_total"),
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

export const SEO_FIELDS = [
  "seoFocusKeyword",
  "seoMetaTitle",
  "seoMetaDescription",
  "canonicalUrl",
  "seoNoIndex",
  "slug",
  "title",
  "descriptionHtml",
  "bulletFeatures",
  "tags",
  "searchKeywords",
  "imageAlts",
] as const;
export type SeoField = (typeof SEO_FIELDS)[number];

export const SEO_FIELD_STATES = ["AUTO", "SUGGESTED", "MANUAL", "LOCKED"] as const;
export type SeoFieldState = (typeof SEO_FIELD_STATES)[number];

/**
 * Who decided each SEO field (migration 0033, D-077).
 *
 * A field a person wrote is MANUAL; a field they fixed is LOCKED and nothing
 * automatic may touch it. A generator's wording is SUGGESTED until someone
 * accepts it. Absence of a row means AUTO — nobody has decided yet.
 */
export const seoFieldStates = pgTable(
  "seo_field_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    field: text("field").$type<SeoField>().notNull(),
    state: text("state").$type<SeoFieldState>().notNull().default("AUTO"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    sourceRunId: uuid("source_run_id").references(() => seoResearchRuns.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("seo_field_states_unique").on(table.productId, table.field),
    index("seo_field_states_product_idx").on(table.productId),
  ],
);

/** Shelf SEO fields, which have history but no per-field state machine. */
export const CATEGORY_SEO_FIELDS = [
  "seoMetaTitle",
  "seoMetaDescription",
  "canonicalUrl",
  "seoNoIndex",
  "slug",
  "name",
  "introHtml",
] as const;
export type CategorySeoField = (typeof CATEGORY_SEO_FIELDS)[number];

/** Any field the change history can carry, listing or shelf. */
export type SeoChangeField = SeoField | CategorySeoField;

/** Which path made a change, so history says how it happened as well as what. */
export const SEO_CHANGE_WORKFLOWS = [
  "editor",
  "seo_pulse_apply",
  "seo_pulse_fill",
  "lock",
  "import",
  "system",
] as const;
export type SeoChangeWorkflow = (typeof SEO_CHANGE_WORKFLOWS)[number];

/**
 * The SEO change history (migration 0033, widened by 0037 — D-098).
 *
 * Append-only: before and after of every change to a listing's or a shelf's
 * SEO fields, with the actor, the reason and the workflow that made it.
 * Section 4.4 of the platform tracker planned a separate `seo_change_history`;
 * this table already had those columns, so it was widened rather than
 * duplicated — two stores holding one kind of record is the mistake this
 * programme keeps closing.
 */
export const seoFieldHistory = pgTable(
  "seo_field_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").$type<"product" | "category">().notNull().default("product"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    field: text("field").$type<SeoChangeField>().notNull(),
    beforeValue: text("before_value"),
    afterValue: text("after_value"),
    beforeState: text("before_state").$type<SeoFieldState>(),
    /** Null for a shelf: no per-field state is stored for one. */
    afterState: text("after_state").$type<SeoFieldState>(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    sourceRunId: uuid("source_run_id").references(() => seoResearchRuns.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    workflow: text("workflow").$type<SeoChangeWorkflow>().notNull().default("editor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("seo_field_history_product_idx").on(table.productId, table.createdAt),
    index("seo_field_history_category_idx").on(table.categoryId, table.createdAt),
    index("seo_field_history_changed_idx").on(table.createdAt),
  ],
);

/**
 * The addresses a listing used to have (D-078). A renamed listing answers on
 * its old address with a permanent redirect, so existing links still arrive.
 */
export const productSlugRedirects = pgTable(
  "product_slug_redirects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromSlug: text("from_slug").notNull().unique(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("product_slug_redirects_product_idx").on(table.productId)],
);
