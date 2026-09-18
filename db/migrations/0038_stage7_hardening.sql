-- Stage 7 of the knowledge platform: corrective database hardening (D-102).
--
-- Nothing here changes what any earlier migration built. It adds the indexes
-- the Stage 7 measurements showed were missing, replaces one index that could
-- never be used because the code that asked for it computed something slightly
-- different, and tightens two constraints that allowed a row nothing should
-- write. Earlier migrations are history and are not edited.

-- 1. Description duplicate checks -------------------------------------------
-- Migration 0035 indexed `md5(left(stripped(description_html), 160))`, but
-- every caller trims the stripped text *before* taking the prefix, so the
-- expressions never matched and the check fell back to a scan of the published
-- listings (risk R-10). Two indexes replace it: one on the comparable form of
-- the whole body, for "the same description word for word", and one on the
-- opening, for "these descriptions start the same way".
--
-- The expression is spelled here exactly as `lib/seo/duplicates.ts` spells it.
-- If one changes, the other must change with it, and the new index goes in a
-- new migration.

DROP INDEX IF EXISTS "products_description_bucket_idx";
--> statement-breakpoint

CREATE INDEX "products_description_norm_idx"
  ON "products" (
    md5(
      btrim(
        regexp_replace(
          lower(regexp_replace(coalesce("description_html", ''), '<[^>]*>', ' ', 'g')),
          '[^a-z0-9]+', ' ', 'g'
        )
      )
    )
  )
  WHERE "archived_at" IS NULL AND "description_html" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX "products_description_opening_idx"
  ON "products" (
    md5(
      left(
        btrim(
          regexp_replace(
            lower(regexp_replace(coalesce("description_html", ''), '<[^>]*>', ' ', 'g')),
            '[^a-z0-9]+', ' ', 'g'
          )
        ),
        160
      )
    )
  )
  WHERE "archived_at" IS NULL AND "description_html" IS NOT NULL;
--> statement-breakpoint

-- 2. The delete paths a listing save actually walks -------------------------
-- Every knowledge sync ends by removing brands nothing refers to any more and
-- variant identities no offer points at. Both are `not exists` over several
-- tables, and both leave PostgreSQL checking cascades on the way out. Without
-- these, each of those checks is a sequential scan — invisible today because
-- the claim and alias tables are nearly empty, and quadratic once they are not
-- (risk R-2).

CREATE INDEX IF NOT EXISTS "pkb_claims_value_brand_idx"
  ON "pkb_claims" ("value_brand_id") WHERE "value_brand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_claims_variant_idx"
  ON "pkb_claims" ("pkb_variant_id", "pkb_product_id") WHERE "pkb_variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_aliases_brand_idx"
  ON "pkb_aliases" ("brand_id") WHERE "brand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_aliases_product_idx"
  ON "pkb_aliases" ("pkb_product_id") WHERE "pkb_product_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_aliases_variant_idx"
  ON "pkb_aliases" ("pkb_variant_id") WHERE "pkb_variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_aliases_definition_idx"
  ON "pkb_aliases" ("definition_id") WHERE "definition_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_source_registry_brand_idx"
  ON "pkb_source_registry" ("brand_id") WHERE "brand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_brands_merged_into_idx"
  ON "pkb_brands" ("merged_into_id") WHERE "merged_into_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_brand_relations_related_idx"
  ON "pkb_brand_relations" ("related_brand_id");
--> statement-breakpoint

-- A variant deleted in the catalogue cascades into the parked rows that
-- mention it, and a listing's parked rows are read once per reconciliation.
CREATE INDEX IF NOT EXISTS "pkb_unmapped_values_variant_idx"
  ON "pkb_unmapped_values" ("variant_id") WHERE "variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_unmapped_values_product_idx"
  ON "pkb_unmapped_values" ("product_id");
--> statement-breakpoint

-- 3. Rows nothing should be able to write -----------------------------------
-- `seo_opportunity_decisions` recorded which kind of thing a finding was about
-- but never checked that the matching column was filled, so a decision could
-- claim to be about a shelf while naming a listing. `seo_field_history` has
-- had this rule since migration 0037; this brings the decision store into line
-- with it. Both directions are checked: the wrong column must be empty, and a
-- site-wide finding must name neither.

ALTER TABLE "seo_opportunity_decisions"
  ADD CONSTRAINT "seo_opportunity_decisions_shape_check" CHECK (
    (entity_type = 'product' AND category_id IS NULL)
    OR (entity_type = 'category' AND product_id IS NULL)
    OR (entity_type = 'site' AND product_id IS NULL AND category_id IS NULL)
  );
--> statement-breakpoint

-- A sync cannot have written, left unchanged or fetched a negative number of
-- rows, nor made a negative number of requests. Nothing writes such a row
-- today; the constraint is what keeps that true.
ALTER TABLE "search_console_syncs"
  ADD CONSTRAINT "search_console_syncs_counts_check" CHECK (
    rows_written >= 0 AND rows_unchanged >= 0 AND rows_fetched >= 0 AND requests_made >= 0
  );
