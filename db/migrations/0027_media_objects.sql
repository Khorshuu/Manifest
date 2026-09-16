-- Media registry (DECISIONS.md D-055).
--
-- One row per file the media provider stored. It is what lets unreferenced
-- files be found and deleted later: object storage cannot be asked "which of
-- your files does the database still point at", and deleting at the moment an
-- image is removed breaks the past orders that recorded its address.
CREATE TABLE "media_objects" (
  "key" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text NOT NULL,
  "bytes" integer NOT NULL,
  "width" integer,
  "height" integer,
  "sha256" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_objects_bytes_check" CHECK ("bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "media_objects_created_at_idx" ON "media_objects" ("created_at");
--> statement-breakpoint
-- The sweep asks whether any order still shows a file; without this that is a
-- scan of every order line per candidate.
CREATE INDEX "order_items_image_url_snapshot_idx" ON "order_items" ("image_url_snapshot")
  WHERE "image_url_snapshot" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "product_images_url_idx" ON "product_images" ("url");
--> statement-breakpoint
CREATE INDEX "variant_images_url_idx" ON "variant_images" ("url");
