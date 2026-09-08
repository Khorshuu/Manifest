import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { productVariants } from "./variants";
import { users } from "./users";

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for a guest cart, which is keyed by sessionToken instead. */
    userId: uuid("user_id").references(() => users.id),
    sessionToken: text("session_token").unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("carts_user_id_idx").on(table.userId)],
);

/**
 * Cart items store no price. Live price and availability are re-read from
 * product_variants on every render — see docs/BUSINESS_LOGIC.md.
 */
export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantity: integer("quantity").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("cart_items_cart_variant_unique").on(table.cartId, table.variantId),
    index("cart_items_cart_id_idx").on(table.cartId),
  ],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wishlist_items_user_variant_unique").on(
      table.userId,
      table.variantId,
    ),
  ],
);
