-- Measurements, and the variant an order actually bought (DECISIONS.md D-043).
--
-- Two unrelated-looking changes that come from the same complaint: what a
-- listing says, and what an order remembers, both lost the specifics.

-- Measurable physical facts, kept apart from the specification table so the
-- product page can offer them as their own tab and hide that tab when there
-- are none. Array<{ label: string; value: string }>, never invented.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "measurements" jsonb;
--> statement-breakpoint

-- What was bought, frozen at the moment of purchase. The order already
-- snapshotted the title and the price; the variant itself was left to be
-- re-read from the live catalogue, which is how "Pearl White / 3-Seater"
-- became a bare product name on every order screen.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "sku_snapshot" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "image_url_snapshot" text;
--> statement-breakpoint
-- Array<{ label: string; value: string }> — "Colour: Pearl White".
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_options_snapshot" jsonb;
