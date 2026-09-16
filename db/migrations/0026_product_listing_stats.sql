-- Listing read model: what shoppers sort and filter by that comes from order
-- history and reviews, kept per product instead of aggregated on every read.
--
-- Measured on 5,000 products and 100,000 orders before this change: the whole
-- catalogue sorted by best selling took 532 ms and a filtered shelf 263 ms,
-- because every listing re-summed order lines and averaged reviews for every
-- matching product (docs/PRODUCTION-READINESS.md, Phase 9).
--
-- Only history-derived figures live here. Price, discount and whether a
-- product can be bought right now depend on sale windows and the clock, so
-- they stay computed at read time from the indexed variants.
--
-- Correctness over cleverness: the triggers never add or subtract. They
-- recompute the affected products from the source rows, inside the same
-- transaction as the change, so the table cannot drift from the orders and
-- reviews it summarises.
CREATE TABLE "product_listing_stats" (
  "product_id" uuid PRIMARY KEY NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "units_sold" integer DEFAULT 0 NOT NULL,
  "review_count" integer DEFAULT 0 NOT NULL,
  "rating_avg" numeric,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Units sold count orders that were paid and not unwound, the same rule the
-- storefront has always used (lib/catalog/facets.ts).
CREATE OR REPLACE FUNCTION refresh_product_listing_stats(ids uuid[]) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO product_listing_stats AS s (product_id, units_sold, review_count, rating_avg, updated_at)
  SELECT p.id,
    coalesce((
      SELECT sum(oi.quantity)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE v.product_id = p.id
        AND o.status NOT IN ('placed', 'cancelled', 'refunded')
    ), 0),
    (SELECT count(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved'),
    (SELECT avg(r.rating) FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved'),
    now()
  FROM products p
  WHERE p.id = ANY(ids)
  ON CONFLICT (product_id) DO UPDATE SET
    units_sold = excluded.units_sold,
    review_count = excluded.review_count,
    rating_avg = excluded.rating_avg,
    updated_at = excluded.updated_at;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION listing_stats_counted(status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT status NOT IN ('placed', 'cancelled', 'refunded');
$$;
--> statement-breakpoint
-- An order moving into or out of a counted status. Most order updates (a
-- tracking reference, a note) change neither side and do nothing.
CREATE OR REPLACE FUNCTION listing_stats_after_order_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_listing_stats(array(
    SELECT DISTINCT v.product_id
    FROM new_orders n
    JOIN old_orders o ON o.id = n.id
    JOIN order_items oi ON oi.order_id = n.id
    JOIN product_variants v ON v.id = oi.variant_id
    WHERE listing_stats_counted(o.status) IS DISTINCT FROM listing_stats_counted(n.status)
  ));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "listing_stats_orders_update"
  AFTER UPDATE ON "orders"
  REFERENCING OLD TABLE AS old_orders NEW TABLE AS new_orders
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_order_update();
--> statement-breakpoint
-- Lines added to or removed from an order that already counts. Checkout adds
-- lines to a 'placed' order, which does not count, so it costs one join.
CREATE OR REPLACE FUNCTION listing_stats_after_order_items() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_listing_stats(array(
    SELECT DISTINCT v.product_id
    FROM changed_items c
    JOIN orders o ON o.id = c.order_id
    JOIN product_variants v ON v.id = c.variant_id
    WHERE listing_stats_counted(o.status)
  ));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "listing_stats_order_items_insert"
  AFTER INSERT ON "order_items"
  REFERENCING NEW TABLE AS changed_items
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_order_items();
--> statement-breakpoint
CREATE TRIGGER "listing_stats_order_items_delete"
  AFTER DELETE ON "order_items"
  REFERENCING OLD TABLE AS changed_items
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_order_items();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION listing_stats_after_reviews() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_listing_stats(array(
    SELECT DISTINCT product_id FROM changed_reviews
  ));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "listing_stats_reviews_insert"
  AFTER INSERT ON "reviews"
  REFERENCING NEW TABLE AS changed_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_reviews();
--> statement-breakpoint
CREATE TRIGGER "listing_stats_reviews_update"
  AFTER UPDATE ON "reviews"
  REFERENCING NEW TABLE AS changed_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_reviews();
--> statement-breakpoint
CREATE TRIGGER "listing_stats_reviews_delete"
  AFTER DELETE ON "reviews"
  REFERENCING OLD TABLE AS changed_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION listing_stats_after_reviews();
--> statement-breakpoint
SELECT refresh_product_listing_stats(array(SELECT id FROM products));
