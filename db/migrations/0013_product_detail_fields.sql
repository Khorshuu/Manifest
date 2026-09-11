-- A listing that can answer a shopper's questions.
--
-- Everything here is additive and nullable: an existing product keeps working
-- untouched, and every new section on the product page hides itself when its
-- column is null (CLAUDE.md section 7 — no fake data, no empty sections).

-- Identity and trade identifiers -------------------------------------------
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sku" text;
--> statement-breakpoint
-- Partial index rather than a UNIQUE constraint: products created before this
-- migration have no SKU, and several nulls must stay legal.
CREATE UNIQUE INDEX IF NOT EXISTS "products_sku_unique"
  ON "products" ("sku") WHERE "sku" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "identifier_type" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "identifier_value" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_identifier_type_check"
    CHECK ("identifier_type" IS NULL
      OR "identifier_type" IN ('gtin', 'upc', 'ean', 'isbn', 'asin', 'mpn', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Listing content -----------------------------------------------------------
-- string[]: "1 x charging cable", one line per item.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "box_contents" jsonb;
--> statement-breakpoint
-- { hasWarranty, durationMonths, type, provider, description, terms }
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "warranty" jsonb;
--> statement-breakpoint
-- { certifications: [{ name, number }], compliance, safety, warnings,
--   countryOfOrigin, regulatory }
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "compliance" jsonb;
--> statement-breakpoint
-- The optional advanced attribute block — manufacturer, model number, package
-- dimensions and the rest. A flat object of optional strings, because none of
-- these is ever queried on; they are printed in the specifications table.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "details" jsonb;
--> statement-breakpoint
-- { [categoryAttributeId]: value } — see the category_attributes table below.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "attribute_values" jsonb;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "video_url" text;
--> statement-breakpoint

-- Search listing ------------------------------------------------------------
-- string[] of keywords fed to the site's own search, kept apart from `tags`,
-- which are shown to shoppers.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_keywords" jsonb;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_no_index" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "canonical_url" text;
--> statement-breakpoint

-- Publishing ----------------------------------------------------------------
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unpublish_at" timestamp with time zone;
--> statement-breakpoint

-- Media ---------------------------------------------------------------------
-- Lifestyle photography lives in the same table as the gallery so ordering,
-- upload, and deletion stay one code path; `kind` is what keeps it out of the
-- buy-box gallery.
ALTER TABLE "product_images" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'gallery';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_images" ADD CONSTRAINT "product_images_kind_check"
    CHECK ("kind" IN ('gallery', 'lifestyle'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Per-variant pricing and stock --------------------------------------------
-- A sale is a second price plus a window, not an edit to the first one: the
-- regular price has to survive the sale so it can be shown struck through and
-- restored when the window closes.
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "sale_price_bdt" integer;
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "sale_starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "sale_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "low_stock_threshold" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sale_price_check"
    CHECK ("sale_price_bdt" IS NULL
      OR ("sale_price_bdt" >= 0 AND "sale_price_bdt" <= "price_bdt"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sale_window_check"
    CHECK ("sale_starts_at" IS NULL OR "sale_ends_at" IS NULL
      OR "sale_ends_at" > "sale_starts_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Category-specific attributes ----------------------------------------------
-- Defined per category at runtime, so a new kind of product does not need a
-- schema change to describe itself (the requirement in section 12 of the
-- product brief). Deliberately separate from `attributes`, which is the
-- variation axis system: a variation multiplies the SKUs, a specification
-- does not, and conflating them would generate combinations nobody wants.
CREATE TABLE IF NOT EXISTS "category_attributes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category_id" uuid NOT NULL REFERENCES "categories"("id"),
  "name" text NOT NULL,
  "data_type" text NOT NULL DEFAULT 'text',
  "unit" text,
  "options" jsonb,
  "is_required" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "category_attributes_data_type_check" CHECK (
    "data_type" IN ('text', 'number', 'boolean', 'select', 'multiselect',
                    'date', 'measurement', 'color', 'url')
  ),
  CONSTRAINT "category_attributes_name_unique" UNIQUE ("category_id", "name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "category_attributes_category_id_idx"
  ON "category_attributes" ("category_id");
--> statement-breakpoint

-- The search index has to learn the new vocabulary, or a highlight, an
-- included item or a specification value would be invisible to search. The
-- expression must stay identical to the one lib/catalog/search.ts builds.
DROP INDEX IF EXISTS "products_search_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_search_idx"
  ON "products"
  USING GIN (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' ||
      coalesce("brand", '') || ' ' ||
      coalesce(regexp_replace("description_html", '<[^>]*>', ' ', 'g'), '') || ' ' ||
      coalesce("tags"::text, '') || ' ' ||
      coalesce("bullet_features"::text, '') || ' ' ||
      coalesce("spec_table"::text, '') || ' ' ||
      coalesce("seo_meta_description", '') || ' ' ||
      coalesce("search_keywords"::text, '') || ' ' ||
      coalesce("box_contents"::text, '') || ' ' ||
      coalesce("attribute_values"::text, '') || ' ' ||
      coalesce("details"::text, '')
    )
  );
