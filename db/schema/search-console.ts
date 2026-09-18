import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { categories, products } from "./catalog";
import { users } from "./users";

/**
 * What Google Search Console reports about this site (migration 0037, D-096).
 *
 * This is measured external analytics, and it is deliberately kept at arm's
 * length from the Product Knowledge Base. A query somebody typed into Google
 * is not a fact about a product, an alias, a piece of SEO copy or an
 * attribute; at most it is a reason to *propose* one of those to a person
 * (D-100). Nothing in these tables is exportable (invariant I-10) and nothing
 * in them identifies a customer (I-9).
 */

export const SEARCH_CONSOLE_DIMENSIONS = ["page", "query", "page_query"] as const;
export type SearchConsoleDimension = (typeof SEARCH_CONSOLE_DIMENSIONS)[number];

export const SEARCH_CONSOLE_SYNC_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;
export type SearchConsoleSyncStatus = (typeof SEARCH_CONSOLE_SYNC_STATUSES)[number];

export const SEARCH_CONSOLE_PROVIDER_STATES = ["OK", "NOT_CONFIGURED", "UNAVAILABLE", "FAILED"] as const;
export type SearchConsoleProviderState = (typeof SEARCH_CONSOLE_PROVIDER_STATES)[number];

export const SEARCH_CONSOLE_STATE_STATUSES = [
  "never_run",
  "ok",
  "not_configured",
  "unavailable",
  "failed",
] as const;
export type SearchConsoleStateStatus = (typeof SEARCH_CONSOLE_STATE_STATUSES)[number];

/**
 * One row per property: the watermark and the last thing that happened.
 *
 * `syncedThrough` is the last day every earlier day has been fetched for. A
 * sync still re-reads a trailing window on top of it, because Search Console
 * revises the most recent days after first reporting them, and re-reading is
 * safe because storage is an upsert on the natural key.
 */
export const searchConsoleSyncState = pgTable("search_console_sync_state", {
  property: text("property").primaryKey(),
  providerKey: text("provider_key").notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastStatus: text("last_status").$type<SearchConsoleStateStatus>().notNull().default("never_run"),
  lastError: text("last_error"),
  syncedThrough: date("synced_through"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One attempt: what was asked for, what came back, and why it failed. */
export const searchConsoleSyncs = pgTable(
  "search_console_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    property: text("property").notNull(),
    /** One key per intended sync, so a retry cannot start a second one. */
    requestKey: text("request_key").notNull().unique(),
    status: text("status").$type<SearchConsoleSyncStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<"manual" | "scheduled">().notNull(),
    requestedBy: uuid("requested_by").references(() => users.id),
    windowStart: date("window_start").notNull(),
    windowEnd: date("window_end").notNull(),
    providerKey: text("provider_key").notNull(),
    providerState: text("provider_state").$type<SearchConsoleProviderState>(),
    requestsMade: integer("requests_made").notNull().default(0),
    rowsFetched: integer("rows_fetched").notNull().default(0),
    rowsWritten: integer("rows_written").notNull().default(0),
    rowsUnchanged: integer("rows_unchanged").notNull().default(0),
    daysCovered: integer("days_covered").notNull().default(0),
    message: text("message"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("search_console_syncs_property_idx").on(table.property, table.createdAt)],
);

/**
 * Exactly what Search Console reported, per day and dimension.
 *
 * `pagePath` and `query` are empty strings where the dimension does not use
 * them, so the natural key is a plain unique index rather than one over
 * nullable columns — which would have let the same measurement be stored
 * twice. `ctr` is a generated column, so it can never disagree with the two
 * counts it comes from. A day that was never fetched has no row at all;
 * absence means "not measured", never zero.
 */
export const searchConsoleMetrics = pgTable(
  "search_console_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    property: text("property").notNull(),
    measuredOn: date("measured_on").notNull(),
    dimension: text("dimension").$type<SearchConsoleDimension>().notNull(),
    pagePath: text("page_path").notNull().default(""),
    query: text("query").notNull().default(""),
    /** The comparison form of the query (lib/search/terms.ts `termKey`). */
    queryKey: text("query_key").notNull().default(""),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    /** Generated from clicks and impressions; never written. */
    ctr: numeric("ctr", { precision: 9, scale: 8 }).generatedAlwaysAs(
      sql`case when impressions > 0 then round(clicks::numeric / impressions, 8) else 0 end`,
    ),
    position: numeric("position", { precision: 6, scale: 2 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncId: uuid("last_sync_id").references(() => searchConsoleSyncs.id, { onDelete: "set null" }),
  },
  (table) => [
    unique("search_console_metrics_unique").on(
      table.property,
      table.measuredOn,
      table.dimension,
      table.pagePath,
      table.query,
    ),
    index("search_console_metrics_window_idx").on(table.property, table.dimension, table.measuredOn),
    check("search_console_metrics_counts_check", sql`${table.clicks} <= ${table.impressions}`),
  ],
);

export const SEO_OPPORTUNITY_DECISIONS = ["acted", "dismissed", "watching"] as const;
export type SeoOpportunityDecision = (typeof SEO_OPPORTUNITY_DECISIONS)[number];

/**
 * What a person decided about an opportunity (D-097).
 *
 * The opportunities themselves are recomputed from the measurements on every
 * read, like the readiness checks and the zero-result verdicts: a stored
 * derived list would have to be kept in step with the data behind it, and a
 * stale row reports work that is no longer there. A decision is the opposite —
 * it is a fact about what the shop did, and nothing can recompute it.
 */
export const seoOpportunityDecisions = pgTable(
  "seo_opportunity_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityKey: text("opportunity_key").notNull().unique(),
    kind: text("kind").notNull(),
    entityType: text("entity_type").$type<"product" | "category" | "site">().notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    decision: text("decision").$type<SeoOpportunityDecision>().notNull(),
    note: text("note"),
    /** The measurements as they stood when the decision was made. */
    evidence: jsonb("evidence"),
    decidedBy: uuid("decided_by")
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("seo_opportunity_decisions_product_idx").on(table.productId),
    index("seo_opportunity_decisions_kind_idx").on(table.kind, table.decidedAt),
  ],
);
