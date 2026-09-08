import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Product lifecycle states from MASTER_PRODUCT_SPEC.md section 2. Held as text
 * with a check constraint rather than a pg enum, because this list is expected
 * to grow and ALTER TYPE is a heavier migration than editing a constraint.
 */
export const PRODUCT_STATUSES = [
  "draft",
  "scheduled",
  "in_stock",
  "preorder_open",
  "preorder_closed",
  "coming_soon",
  "discontinued",
  "archived",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("categories_parent_id_idx").on(table.parentId)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    brand: text("brand"),
    descriptionHtml: text("description_html"),
    /** string[] */
    bulletFeatures: jsonb("bullet_features"),
    /** Array<{ label: string; value: string }> */
    specTable: jsonb("spec_table"),
    /** string[] */
    tags: jsonb("tags"),
    seoMetaTitle: text("seo_meta_title"),
    seoMetaDescription: text("seo_meta_description"),
    status: text("status").notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "products_status_check",
      sql`${table.status} in ('draft', 'scheduled', 'in_stock', 'preorder_open', 'preorder_closed', 'coming_soon', 'discontinued', 'archived')`,
    ),
    index("products_category_id_idx").on(table.categoryId),
    index("products_status_idx").on(table.status),
  ],
);

/** Secondary categories. The primary one lives on products.category_id. */
export const productCategories = pgTable(
  "product_categories",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
  },
  (table) => [primaryKey({ columns: [table.productId, table.categoryId] })],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    url: text("url").notNull(),
    altText: text("alt_text").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("product_images_product_id_idx").on(table.productId)],
);

export const PRODUCT_RELATION_KINDS = [
  "related",
  "frequently_bought_together",
  "also_viewed",
] as const;
export type ProductRelationKind = (typeof PRODUCT_RELATION_KINDS)[number];

export const productRelated = pgTable(
  "product_related",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    relatedProductId: uuid("related_product_id")
      .notNull()
      .references(() => products.id),
    kind: text("kind").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.relatedProductId, table.kind],
    }),
    check(
      "product_related_kind_check",
      sql`${table.kind} in ('related', 'frequently_bought_together', 'also_viewed')`,
    ),
  ],
);
