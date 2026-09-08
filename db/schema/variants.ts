import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { users } from "./users";

/**
 * Attribute system is EAV so admins can define arbitrary attribute types at
 * runtime (MASTER_PRODUCT_SPEC.md section 2) — see DECISIONS.md D-006.
 */
export const ATTRIBUTE_INPUT_TYPES = ["select", "text", "number"] as const;
export type AttributeInputType = (typeof ATTRIBUTE_INPUT_TYPES)[number];

export const attributes = pgTable(
  "attributes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    inputType: text("input_type").notNull().default("select"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "attributes_input_type_check",
      sql`${table.inputType} in ('select', 'text', 'number')`,
    ),
  ],
);

export const attributeValues = pgTable(
  "attribute_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => attributes.id),
    value: text("value").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    unique("attribute_values_attribute_value_unique").on(
      table.attributeId,
      table.value,
    ),
  ],
);

/** Which attributes a given product varies by. */
export const productAttributes = pgTable(
  "product_attributes",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => attributes.id),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.productId, table.attributeId] })],
);

export const FULFILLMENT_MODES = ["in_stock", "preorder"] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export const PAYMENT_MODES = ["full", "deposit"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sku: text("sku").notNull().unique(),
    /** BDT paisa. A full price, or a delta on the product base when priceIsDelta. */
    priceBdt: integer("price_bdt").notNull(),
    priceIsDelta: boolean("price_is_delta").notNull().default(false),
    /** USD cents. Sourcing cost — never exposed to a customer session. */
    costPriceUsd: integer("cost_price_usd"),
    weightGrams: integer("weight_grams"),
    /** { length: number; width: number; height: number } in mm */
    dimensionsMm: jsonb("dimensions_mm"),
    /** false = a generated combination the admin deliberately disabled */
    isEnabled: boolean("is_enabled").notNull().default(true),
    fulfillmentMode: text("fulfillment_mode").notNull().default("preorder"),
    stockQuantity: integer("stock_quantity"),
    preorderCapacity: integer("preorder_capacity"),
    /** Only ever changed inside the locked capacity transaction — see BUSINESS_LOGIC.md */
    preorderReserved: integer("preorder_reserved").notNull().default(0),
    preorderClosesAt: timestamp("preorder_closes_at", { withTimezone: true }),
    estimatedArrivalFrom: timestamp("estimated_arrival_from", {
      withTimezone: true,
    }),
    estimatedArrivalTo: timestamp("estimated_arrival_to", {
      withTimezone: true,
    }),
    paymentMode: text("payment_mode").notNull().default("full"),
    depositPercent: integer("deposit_percent"),
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
      "product_variants_fulfillment_mode_check",
      sql`${table.fulfillmentMode} in ('in_stock', 'preorder')`,
    ),
    check(
      "product_variants_payment_mode_check",
      sql`${table.paymentMode} in ('full', 'deposit')`,
    ),
    check(
      "product_variants_deposit_percent_check",
      sql`${table.depositPercent} is null or (${table.depositPercent} > 0 and ${table.depositPercent} < 100)`,
    ),
    /** A deposit variant is meaningless without the percentage to charge. */
    check(
      "product_variants_deposit_requires_percent_check",
      sql`${table.paymentMode} <> 'deposit' or ${table.depositPercent} is not null`,
    ),
    /** The invariant the capacity engine depends on; the transaction enforces it too. */
    check(
      "product_variants_reserved_within_capacity_check",
      sql`${table.preorderCapacity} is null or ${table.preorderReserved} <= ${table.preorderCapacity}`,
    ),
    check(
      "product_variants_reserved_non_negative_check",
      sql`${table.preorderReserved} >= 0`,
    ),
    index("product_variants_product_id_idx").on(table.productId),
    index("product_variants_preorder_window_idx").on(
      table.fulfillmentMode,
      table.preorderClosesAt,
    ),
  ],
);

/** One row per (variant, attribute): the value this combination represents. */
export const variantOptionValues = pgTable(
  "variant_option_values",
  {
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => attributes.id),
    attributeValueId: uuid("attribute_value_id")
      .notNull()
      .references(() => attributeValues.id),
  },
  (table) => [primaryKey({ columns: [table.variantId, table.attributeId] })],
);

export const variantImages = pgTable(
  "variant_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    url: text("url").notNull(),
    altText: text("alt_text").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [index("variant_images_variant_id_idx").on(table.variantId)],
);

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    userId: uuid("user_id").references(() => users.id),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (table) => [index("waitlist_entries_variant_id_idx").on(table.variantId)],
);

/** Stock movements for in_stock variants, with a required reason (audit trail). */
export const inventoryAdjustments = pgTable(
  "inventory_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inventory_adjustments_variant_id_idx").on(table.variantId),
  ],
);
