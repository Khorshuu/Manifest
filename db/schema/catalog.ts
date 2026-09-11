import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
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
    /** The shop's own stock-keeping code for the listing. Unique when set. */
    sku: text("sku"),
    /** One of PRODUCT_IDENTIFIER_TYPES — a GTIN, UPC, EAN, ISBN and so on. */
    identifierType: text("identifier_type"),
    identifierValue: text("identifier_value"),
    descriptionHtml: text("description_html"),
    /** string[] */
    bulletFeatures: jsonb("bullet_features"),
    /** Array<{ label: string; value: string }> */
    specTable: jsonb("spec_table"),
    /** string[] — "1 x charging cable" and the rest of the box. */
    boxContents: jsonb("box_contents"),
    /** ProductWarranty | null */
    warranty: jsonb("warranty"),
    /** ProductCompliance | null */
    compliance: jsonb("compliance"),
    /** ProductDetails | null — the optional advanced attribute block. */
    details: jsonb("details"),
    /** Record<categoryAttributeId, string | string[] | number | boolean> */
    attributeValues: jsonb("attribute_values"),
    /** A hosted or embedded product video. */
    videoUrl: text("video_url"),
    /** string[] */
    tags: jsonb("tags"),
    /** string[] — fed to the site's own search, never shown to a shopper. */
    searchKeywords: jsonb("search_keywords"),
    /** The one phrase the listing is written to rank for. Never shown. */
    seoFocusKeyword: text("seo_focus_keyword"),
    seoMetaTitle: text("seo_meta_title"),
    seoMetaDescription: text("seo_meta_description"),
    seoNoIndex: boolean("seo_no_index").notNull().default(false),
    canonicalUrl: text("canonical_url"),
    /**
     * Whether the site's own search can find this listing. Off hides it from
     * the search box and its suggestions only — the product page, category
     * listings and the cart are untouched.
     */
    searchable: boolean("searchable").notNull().default(true),
    /**
     * -2 to 2. Reorders products the ranking already considers equally
     * relevant; it can never lift a weaker match above a stronger one.
     */
    searchBoost: smallint("search_boost").notNull().default(0),
    status: text("status").notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    unpublishAt: timestamp("unpublish_at", { withTimezone: true }),
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
    check(
      "products_search_boost_check",
      sql`${table.searchBoost} between -2 and 2`,
    ),
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
    /** 'gallery' is the buy-box gallery; 'lifestyle' is the in-use imagery. */
    kind: text("kind").notNull().default("gallery"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("product_images_product_id_idx").on(table.productId),
    check(
      "product_images_kind_check",
      sql`${table.kind} in ('gallery', 'lifestyle')`,
    ),
  ],
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

/**
 * The kinds of trade identifier a listing may carry. Optional by design —
 * a locally sourced accessory has none, and demanding one would be a lie.
 */
export const PRODUCT_IDENTIFIER_TYPES = [
  "gtin",
  "upc",
  "ean",
  "isbn",
  "asin",
  "mpn",
  "other",
] as const;
export type ProductIdentifierType = (typeof PRODUCT_IDENTIFIER_TYPES)[number];

export const PRODUCT_IMAGE_KINDS = ["gallery", "lifestyle"] as const;
export type ProductImageKind = (typeof PRODUCT_IMAGE_KINDS)[number];

/**
 * The data types a category attribute may take. The list is closed because
 * each one has to be rendered as an input and formatted for the spec table;
 * an unknown type would be an unlabelled text box.
 */
export const CATEGORY_ATTRIBUTE_TYPES = [
  "text",
  "number",
  "boolean",
  "select",
  "multiselect",
  "date",
  "measurement",
  "color",
  "url",
] as const;
export type CategoryAttributeType = (typeof CATEGORY_ATTRIBUTE_TYPES)[number];

/**
 * Specifications a category asks its products for — "Refresh rate" under
 * Monitors, "Fabric" under Clothing.
 *
 * Deliberately not the `attributes` table in db/schema/variants.ts. That one
 * is the variation axis system: adding a value there multiplies the SKUs. A
 * specification describes one product and generates nothing, so keeping the
 * two apart is what stops "Processor" from producing a variant per processor.
 */
export const categoryAttributes = pgTable(
  "category_attributes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    name: text("name").notNull(),
    dataType: text("data_type").notNull().default("text"),
    /** "GHz", "mm", "g" — appended when the value is shown. */
    unit: text("unit"),
    /** string[]: the choices, for select and multiselect. */
    options: jsonb("options"),
    isRequired: boolean("is_required").notNull().default(false),
    /** Offered as a filter on listings whose results carry a value for it. */
    isFilterable: boolean("is_filterable").notNull().default(true),
    /** Its values are words the site's search matches. */
    isSearchable: boolean("is_searchable").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("category_attributes_category_id_idx").on(table.categoryId),
    unique("category_attributes_name_unique").on(table.categoryId, table.name),
    check(
      "category_attributes_data_type_check",
      sql`${table.dataType} in ('text', 'number', 'boolean', 'select', 'multiselect', 'date', 'measurement', 'color', 'url')`,
    ),
  ],
);

/** The shape stored in products.warranty. Every field optional but the flag. */
export type ProductWarranty = {
  hasWarranty: boolean;
  durationMonths?: number | null;
  type?: string | null;
  provider?: string | null;
  description?: string | null;
  terms?: string | null;
};

/** The shape stored in products.compliance. */
export type ProductCompliance = {
  certifications?: { name: string; number?: string | null }[];
  compliance?: string | null;
  safety?: string | null;
  warnings?: string | null;
  countryOfOrigin?: string | null;
  regulatory?: string | null;
};

/**
 * The shape stored in products.details — the advanced attribute block. Every
 * key is optional, and only the ones with a value are ever rendered.
 */
export type ProductDetails = {
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  modelNumber?: string | null;
  modelName?: string | null;
  releaseDate?: string | null;
  unitCount?: string | null;
  unitType?: string | null;
  material?: string | null;
  color?: string | null;
  size?: string | null;
  dimensions?: string | null;
  itemWeight?: string | null;
  packageDimensions?: string | null;
  packageWeight?: string | null;
  compatibility?: string | null;
  specialFeatures?: string | null;
  intendedUse?: string | null;
  careInstructions?: string | null;
};
