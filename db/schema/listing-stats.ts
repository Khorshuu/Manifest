import { integer, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { products } from "./catalog";

/**
 * Listing read model (migration 0026): history-derived figures per product,
 * recomputed from orders and reviews by triggers in the same transaction as the
 * change. Written only by the database; the application reads it.
 */
export const productListingStats = pgTable("product_listing_stats", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  unitsSold: integer("units_sold").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  ratingAvg: numeric("rating_avg"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
