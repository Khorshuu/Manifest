-- Stage 4 of the knowledge platform, continued: category SEO and the audit
-- work (D-084, D-085).
--
-- Two things were missing from the first half of the stage. A category page
-- is a landing page in its own right, and until now every one of them carried
-- the same generated sentence with the shelf name swapped in -- which is
-- duplicate, thin content written by the shop itself. And the duplicate and
-- near-duplicate checks over listing copy need the comparisons to be cheap
-- enough to run on a real catalogue, which means indexes on the values being
-- compared rather than a new derived table nobody can verify by hand.

-- 1. Category SEO ------------------------------------------------------------
-- The same four fields a listing has, with the same meaning. Null is "nothing
-- written", never an empty string: an empty value would be indistinguishable
-- from a deliberate blank, and the storefront falls back to the category name.

ALTER TABLE "categories"
  ADD COLUMN "seo_meta_title" text,
  ADD COLUMN "seo_meta_description" text,
  ADD COLUMN "seo_no_index" boolean NOT NULL DEFAULT false,
  ADD COLUMN "canonical_url" text,
  -- A sentence or two of real copy for the top of the shelf. Optional, and
  -- written by a person: nothing generates it.
  ADD COLUMN "intro_html" text;

COMMENT ON COLUMN "categories"."seo_no_index" IS 'Keeps the shelf out of the sitemap and sends a noindex header. A shelf hidden from search is still reachable on the site.';

-- 2. Making the duplicate checks cheap ---------------------------------------
-- Duplicate detection compares the normalized text of one listing with every
-- other listing's. Without these the health screen is a sequential scan per
-- check; with them each check is an index lookup per row.

CREATE INDEX "products_seo_meta_title_norm_idx"
  ON "products" (lower(btrim("seo_meta_title")))
  WHERE "archived_at" IS NULL AND "seo_meta_title" IS NOT NULL;

CREATE INDEX "products_seo_meta_description_norm_idx"
  ON "products" (lower(btrim("seo_meta_description")))
  WHERE "archived_at" IS NULL AND "seo_meta_description" IS NOT NULL;

CREATE INDEX "products_title_norm_idx"
  ON "products" (lower(btrim("title")))
  WHERE "archived_at" IS NULL;

-- Near-duplicate description bodies are compared within a bucket rather than
-- pairwise across the catalogue: the hash of the first stretch of the stripped
-- text. Two bodies that differ only later in the page land in the same bucket
-- and are then compared in full; two that differ at the start never are.
CREATE INDEX "products_description_bucket_idx"
  ON "products" (
    md5(
      left(
        regexp_replace(
          lower(regexp_replace(coalesce("description_html", ''), '<[^>]*>', ' ', 'g')),
          '[^a-z0-9]+', ' ', 'g'
        ),
        160
      )
    )
  )
  WHERE "archived_at" IS NULL AND "description_html" IS NOT NULL;
