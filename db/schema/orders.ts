import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { addresses, users } from "./users";
import { productVariants } from "./variants";

/**
 * The order pipeline from MASTER_PRODUCT_SPEC.md section 4. Status only moves
 * forward, or sideways into cancelled/refunded — see docs/BUSINESS_LOGIC.md.
 */
export const ORDER_STATUSES = [
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const ORDER_STATUS_SQL_LIST = ORDER_STATUSES.map((s) => `'${s}'`).join(", ");

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-facing, e.g. "ORD-2026-000123" */
    orderNumber: text("order_number").notNull().unique(),
    userId: uuid("user_id").references(() => users.id),
    guestEmail: text("guest_email"),
    guestPhone: text("guest_phone"),
    status: text("status").notNull().default("placed"),
    shippingAddressId: uuid("shipping_address_id")
      .notNull()
      .references(() => addresses.id),
    subtotalBdt: integer("subtotal_bdt").notNull(),
    shippingFeeBdt: integer("shipping_fee_bdt").notNull().default(0),
    discountBdt: integer("discount_bdt").notNull().default(0),
    totalBdt: integer("total_bdt").notNull(),
    /** Deposit or full amount actually charged at placement. */
    amountDueNowBdt: integer("amount_due_now_bdt").notNull(),
    /** Unique constraint is what makes order creation idempotent under retry. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    internalNotes: text("internal_notes"),
    trackingReference: text("tracking_reference"),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    check("orders_status_check", sql`${table.status} in (${sql.raw(ORDER_STATUS_SQL_LIST)})`),
    /** A customer order is either owned by a user or carries guest contact details. */
    check(
      "orders_contact_present_check",
      sql`${table.userId} is not null or ${table.guestEmail} is not null`,
    ),
    index("orders_user_placed_idx").on(table.userId, table.placedAt),
    index("orders_status_idx").on(table.status),
  ],
);

/** Line items snapshot title and price at purchase — never re-joined to live catalog. */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    titleSnapshot: text("title_snapshot").notNull(),
    /** e.g. "Color: Red, Storage: 128GB" */
    optionSummarySnapshot: text("option_summary_snapshot"),
    unitPriceBdt: integer("unit_price_bdt").notNull(),
    quantity: integer("quantity").notNull(),
    fulfillmentModeSnapshot: text("fulfillment_mode_snapshot").notNull(),
    estimatedArrivalSnapshot: timestamp("estimated_arrival_snapshot", {
      withTimezone: true,
    }),
  },
  (table) => [
    check("order_items_quantity_check", sql`${table.quantity} > 0`),
    index("order_items_order_id_idx").on(table.orderId),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    status: text("status").notNull(),
    note: text("note"),
    /** Null means a system or webhook-driven transition. */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "order_status_history_status_check",
      sql`${table.status} in (${sql.raw(ORDER_STATUS_SQL_LIST)})`,
    ),
    index("order_status_history_order_id_idx").on(table.orderId),
  ],
);

export const PAYMENT_KINDS = ["deposit", "balance", "full", "refund"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATUSES = [
  "initiated",
  "authorized",
  "captured",
  "failed",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    kind: text("kind").notNull(),
    /** 'mock' until real gateway credentials exist — see DECISIONS.md D-004. */
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    /** bkash, nagad, rocket, card, bank_transfer, cod */
    method: text("method"),
    amountBdt: integer("amount_bdt").notNull(),
    status: text("status").notNull().default("initiated"),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "payments_kind_check",
      sql`${table.kind} in ('deposit', 'balance', 'full', 'refund')`,
    ),
    check(
      "payments_status_check",
      sql`${table.status} in ('initiated', 'authorized', 'captured', 'failed', 'refunded')`,
    ),
    index("payments_order_id_idx").on(table.orderId),
    index("payments_provider_ref_idx").on(table.providerRef),
  ],
);
