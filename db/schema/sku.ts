import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { users } from "./users";

export const SKU_RESERVATION_STATUSES = ["reserved", "finalized", "released"] as const;
export type SkuReservationStatus = (typeof SKU_RESERVATION_STATUSES)[number];

/**
 * The lifecycle of a product SKU (DECISIONS.md D-037): reserved for an unsaved
 * Add Product form, finalized when the product is saved (permanent, never
 * generated again), or released when the form is abandoned or the hold
 * expires. See migration 0018 and lib/catalog/sku.ts.
 */
export const skuReservations = pgTable(
  "sku_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    status: text("status").notNull().default("reserved"),
    reservedBy: uuid("reserved_by")
      .notNull()
      .references(() => users.id),
    productId: uuid("product_id").references(() => products.id),
    reservedAt: timestamp("reserved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "sku_reservations_status_check",
      sql`${table.status} in ('reserved', 'finalized', 'released')`,
    ),
    uniqueIndex("sku_reservations_held_sku_unique")
      .on(table.sku)
      .where(sql`${table.status} in ('reserved', 'finalized')`),
    index("sku_reservations_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'reserved'`),
  ],
);
