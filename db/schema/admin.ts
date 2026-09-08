import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { orderItems } from "./orders";
import { users } from "./users";

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * order_item_id is what makes "verified/delivered purchase" checkable in one
 * join, rather than a flag someone has to remember to set — see DATABASE.md.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    rating: integer("rating").notNull(),
    title: text("title"),
    body: text("body"),
    status: text("status").notNull().default("pending"),
    helpfulCount: integer("helpful_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("reviews_user_product_unique").on(table.userId, table.productId),
    check(
      "reviews_rating_check",
      sql`${table.rating} between 1 and 5`,
    ),
    check(
      "reviews_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected')`,
    ),
    index("reviews_product_status_idx").on(table.productId, table.status),
  ],
);

/**
 * Append-only from application code. Written in the same transaction as the
 * mutation it records — an audit entry that can fail separately is not an
 * audit trail (docs/BUSINESS_LOGIC.md).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    /** e.g. "product.price_changed", "variant.capacity_changed" */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_created_at_idx").on(table.createdAt),
  ],
);

/** Site-wide configuration. Only super_admin may write — see SECURITY.md. */
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
