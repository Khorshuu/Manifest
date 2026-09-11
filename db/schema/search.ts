import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { users } from "./users";

/**
 * Search and discovery — see db/migrations/0014_search_discovery.sql, which is
 * the source of truth for these tables, their triggers and the function that
 * builds the index rows. The declarations here exist so application code can
 * read and write them through Drizzle; nothing in `lib/` writes to
 * `product_search` or `product_search_words` directly, because the database
 * keeps them in step with the catalogue by itself.
 */

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** One row per product: the weighted document and what the ranking compares. */
export const productSearch = pgTable(
  "product_search",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    document: tsvector("document").notNull(),
    titleNorm: text("title_norm").notNull(),
    /** The name up to its first comma, bracket or dash — what the product is. */
    titleCore: text("title_core").notNull(),
    titleWords: smallint("title_words").notNull(),
    brandNorm: text("brand_norm").notNull().default(""),
    categoryNorm: text("category_norm").notNull().default(""),
    /** SKUs, trade identifiers, model and part numbers, punctuation removed. */
    codes: text("codes").array().notNull().default(sql`'{}'::text[]`),
    textA: text("text_a").notNull().default(""),
    textB: text("text_b").notNull().default(""),
    textC: text("text_c").notNull().default(""),
    textD: text("text_d").notNull().default(""),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("product_search_document_idx").on(table.document)],
);

/** Each listing's vocabulary — what a misspelling is corrected against. */
export const productSearchWords = pgTable(
  "product_search_words",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    word: text("word").notNull(),
    /** As the listing spells it, so a correction reads "iPhone". */
    display: text("display").notNull(),
    /** 4 the name … 1 the description. */
    weight: smallint("weight").notNull(),
  },
  (table) => [primaryKey({ columns: [table.productId, table.word] })],
);

/**
 * Products waiting for their index row to be rebuilt. Normally empty outside
 * a transaction; a row that survives one is a rebuild that failed, and the
 * scheduled sweep retries it.
 */
export const productSearchQueue = pgTable("product_search_queue", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  queuedAt: timestamp("queued_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  attempts: integer("attempts").notNull().default(0),
});

/**
 * Synonyms staff maintain. `term` is what a shopper types, `synonyms` what else
 * to look for; a two-way entry also maps every synonym back to the term. All
 * values are stored normalised (lowercase words separated by single spaces).
 */
export const searchSynonyms = pgTable(
  "search_synonyms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    term: text("term").notNull(),
    synonyms: text("synonyms").array().notNull(),
    bidirectional: boolean("bidirectional").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("search_synonyms_term_unique").on(table.term)],
);

/**
 * One row per visitor, query and half hour. `visitor_hash` is a keyed hash of
 * the connection that rotates daily — enough to count people, not enough to
 * follow one. No account id is stored.
 */
export const searchQueries = pgTable(
  "search_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    query: text("query").notNull(),
    queryNorm: text("query_norm").notNull(),
    resultsCount: integer("results_count").notNull(),
    correctedQuery: text("corrected_query"),
    visitorHash: text("visitor_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("search_queries_visit_unique").on(
      table.visitorHash,
      table.queryNorm,
      table.windowStart,
    ),
    index("search_queries_created_at_idx").on(table.createdAt),
  ],
);

export const searchClicks = pgTable(
  "search_clicks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryNorm: text("query_norm").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    position: integer("position"),
    visitorHash: text("visitor_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("search_clicks_visit_unique").on(
      table.visitorHash,
      table.queryNorm,
      table.productId,
      table.windowStart,
    ),
  ],
);

/** A signed-in customer's own recent searches. */
export const searchHistory = pgTable(
  "search_history",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    queryNorm: text("query_norm").notNull(),
    searchedAt: timestamp("searched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.queryNorm] })],
);
