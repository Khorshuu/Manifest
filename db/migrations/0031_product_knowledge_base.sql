-- Product Knowledge Base (docs/KNOWLEDGE_PLATFORM.md, DECISIONS.md D-060 to D-070).
--
-- The reusable record of what each product IS, kept apart from the listing
-- that sells it (products) and the offer that prices it (product_variants):
-- brands, families and their versioned schemas, a global attribute vocabulary,
-- product and variant identities, typed facts with provenance, identifiers,
-- relationships, aliases, sources, evidence and claims.
--
-- Rules the database itself enforces here, so no code path can skip them:
--  * a VERIFIED value needs an accepted claim (which needs evidence) and a
--    recorded decision basis — never a migration, never AI;
--  * LEGACY values and UNKNOWN_LEGACY origin always go together;
--  * unknown is the absence of a row; "not applicable", false and zero are
--    values, and a normalized value has the typed column its definition needs;
--  * AI is not a source type, and AI-assisted extraction must quote a real
--    excerpt;
--  * fact history is append-only; an active family schema is immutable.
--
-- Nothing existing changes meaning. Four nullable link columns are added, and
-- triggers queue a listing whenever the legacy columns its knowledge mirrors
-- change (pkb_sync_queue), so the knowledge base cannot silently fall behind.
-- Every existing listing is queued at the end; the `pkb.sync_listings` job or
-- `npm run pkb:backfill` imports them.

CREATE DOMAIN pkb_origin AS text CHECK (VALUE IN (
  'MANIFEST_CREATED', 'MANUAL_ADMIN', 'OFFICIAL_MANUFACTURER', 'APPROVED_EXTERNAL_SOURCE',
  'SUPPLIER_PROVIDED', 'PROVIDER_RESTRICTED', 'CUSTOMER_DERIVED', 'UNKNOWN_LEGACY'
));
--> statement-breakpoint
CREATE DOMAIN pkb_verification_state AS text CHECK (VALUE IN ('VERIFIED', 'MANUAL', 'UNVERIFIED', 'LEGACY'));
--> statement-breakpoint
CREATE DOMAIN pkb_review_status AS text CHECK (VALUE IN ('suggested', 'approved', 'retired'));
--> statement-breakpoint
CREATE DOMAIN pkb_value_status AS text CHECK (VALUE IN ('normalized', 'unnormalized', 'not_applicable'));
--> statement-breakpoint

-- Brands ---------------------------------------------------------------------
CREATE TABLE "pkb_brands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_normalized" text NOT NULL,
  "slug" text NOT NULL,
  "status" pkb_review_status NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_brands_name_normalized_unique" UNIQUE ("name_normalized"),
  CONSTRAINT "pkb_brands_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "pkb_brands_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120 AND length("name_normalized") >= 1),
  CONSTRAINT "pkb_brands_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "pkb_brands_decision_check" CHECK (("status" = 'approved') <= ("decided_at" IS NOT NULL))
);
--> statement-breakpoint

-- Attribute vocabulary ---------------------------------------------------------
CREATE TABLE "pkb_attribute_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "data_type" text NOT NULL,
  "cardinality" text NOT NULL DEFAULT 'single',
  "unit_dimension" text,
  "display_unit" text,
  "validation" jsonb,
  "searchable" boolean NOT NULL DEFAULT false,
  "filterable" boolean NOT NULL DEFAULT false,
  "seo_relevant" boolean NOT NULL DEFAULT false,
  "structured_data_property" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "status" pkb_review_status NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_attribute_definitions_key_unique" UNIQUE ("key"),
  CONSTRAINT "pkb_attribute_definitions_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT "pkb_attribute_definitions_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 120),
  CONSTRAINT "pkb_attribute_definitions_data_type_check" CHECK ("data_type" IN
    ('text', 'number', 'quantity', 'quantity_range', 'boolean', 'enum', 'date', 'url', 'brand')),
  CONSTRAINT "pkb_attribute_definitions_cardinality_check" CHECK ("cardinality" IN ('single', 'multiple')),
  CONSTRAINT "pkb_attribute_definitions_unit_check" CHECK (
    ("data_type" IN ('quantity', 'quantity_range')) = ("unit_dimension" IS NOT NULL)),
  CONSTRAINT "pkb_attribute_definitions_dimension_format_check" CHECK (
    "unit_dimension" IS NULL OR "unit_dimension" ~ '^[a-z][a-z_]*$'),
  CONSTRAINT "pkb_attribute_definitions_single_valued_check" CHECK (
    "data_type" NOT IN ('boolean', 'brand', 'quantity_range') OR "cardinality" = 'single'),
  CONSTRAINT "pkb_attribute_definitions_validation_check" CHECK (
    "validation" IS NULL OR jsonb_typeof("validation") = 'object'),
  CONSTRAINT "pkb_attribute_definitions_decision_check" CHECK (("status" = 'approved') <= ("decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pkb_attribute_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "definition_id" uuid NOT NULL REFERENCES "pkb_attribute_definitions"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "status" pkb_review_status NOT NULL DEFAULT 'approved',
  "origin" pkb_origin NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_attribute_options_key_unique" UNIQUE ("definition_id", "key"),
  -- The target of the (option, definition) foreign keys below: an option can
  -- only ever be the value of its own definition.
  CONSTRAINT "pkb_attribute_options_id_definition_unique" UNIQUE ("id", "definition_id"),
  CONSTRAINT "pkb_attribute_options_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9_]{0,62}$'),
  CONSTRAINT "pkb_attribute_options_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE FUNCTION pkb_attribute_options_enum_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT data_type FROM pkb_attribute_definitions WHERE id = NEW.definition_id) <> 'enum' THEN
    RAISE EXCEPTION 'Only enum attributes have options.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_attribute_options_enum_only"
  BEFORE INSERT OR UPDATE OF "definition_id" ON "pkb_attribute_options"
  FOR EACH ROW EXECUTE FUNCTION pkb_attribute_options_enum_only();
--> statement-breakpoint

-- Families and their versioned schemas -----------------------------------------
CREATE TABLE "pkb_families" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "parent_id" uuid REFERENCES "pkb_families"("id"),
  "status" pkb_review_status NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  -- Set when the family mirrors a category's specifications (D-064, A-3).
  "legacy_category_id" uuid REFERENCES "categories"("id") ON DELETE SET NULL,
  "suggested_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_families_key_unique" UNIQUE ("key"),
  CONSTRAINT "pkb_families_legacy_category_unique" UNIQUE ("legacy_category_id"),
  CONSTRAINT "pkb_families_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT "pkb_families_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "pkb_families_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"),
  CONSTRAINT "pkb_families_decision_check" CHECK (("status" = 'approved') <= ("decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION pkb_families_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  depth integer;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT f.id, f.parent_id, 1 AS depth FROM pkb_families f WHERE f.id = NEW.parent_id
      UNION ALL
      SELECT f.id, f.parent_id, up.depth + 1 FROM pkb_families f JOIN up ON f.id = up.parent_id
      WHERE up.depth < 64
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A family cannot be its own ancestor.' USING ERRCODE = 'check_violation';
  END IF;
  WITH RECURSIVE up AS (
    SELECT f.id, f.parent_id, 1 AS depth FROM pkb_families f WHERE f.id = NEW.parent_id
    UNION ALL
    SELECT f.id, f.parent_id, up.depth + 1 FROM pkb_families f JOIN up ON f.id = up.parent_id
    WHERE up.depth < 64
  )
  SELECT max(up.depth) INTO depth FROM up;
  IF depth >= 8 THEN
    RAISE EXCEPTION 'Families nest at most eight deep.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_families_no_cycle"
  BEFORE INSERT OR UPDATE OF "parent_id" ON "pkb_families"
  FOR EACH ROW EXECUTE FUNCTION pkb_families_no_cycle();
--> statement-breakpoint
CREATE TABLE "pkb_family_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "pkb_families"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "change_note" text,
  "created_by" uuid REFERENCES "users"("id"),
  "activated_by" uuid REFERENCES "users"("id"),
  "activated_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_family_versions_version_unique" UNIQUE ("family_id", "version"),
  CONSTRAINT "pkb_family_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "pkb_family_versions_status_check" CHECK ("status" IN ('draft', 'active', 'retired')),
  CONSTRAINT "pkb_family_versions_activation_check" CHECK (("status" = 'draft') = ("activated_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_family_versions_one_active" ON "pkb_family_versions" ("family_id") WHERE "status" = 'active';
--> statement-breakpoint
-- A version moves draft to active to retired and never back; only a draft may be
-- deleted.
CREATE FUNCTION pkb_family_versions_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'Only a draft family version can be deleted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.family_id <> OLD.family_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'A family version cannot move to another family or number.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'draft' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'A family version cannot go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_family_versions_lifecycle"
  BEFORE UPDATE OR DELETE ON "pkb_family_versions"
  FOR EACH ROW EXECUTE FUNCTION pkb_family_versions_lifecycle();
--> statement-breakpoint
CREATE TABLE "pkb_family_attributes" (
  "family_version_id" uuid NOT NULL REFERENCES "pkb_family_versions"("id") ON DELETE CASCADE,
  "definition_id" uuid NOT NULL REFERENCES "pkb_attribute_definitions"("id"),
  "requirement" text NOT NULL DEFAULT 'optional',
  "variant_defining" boolean NOT NULL DEFAULT false,
  "searchable" boolean,
  "filterable" boolean,
  "seo_relevant" boolean,
  "group_label" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("family_version_id", "definition_id"),
  CONSTRAINT "pkb_family_attributes_requirement_check" CHECK ("requirement" IN ('required', 'recommended', 'optional'))
);
--> statement-breakpoint
CREATE INDEX "pkb_family_attributes_definition_idx" ON "pkb_family_attributes" ("definition_id");
--> statement-breakpoint
-- Schema evolution is a new version: the attributes of an active or retired
-- version never change.
CREATE FUNCTION pkb_family_attributes_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_id uuid;
BEGIN
  version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.family_version_id ELSE NEW.family_version_id END;
  IF pg_trigger_depth() < 2
     AND (SELECT status FROM pkb_family_versions WHERE id = version_id) <> 'draft' THEN
    RAISE EXCEPTION 'The attributes of an active or retired family version cannot change; create a new version.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.family_version_id <> NEW.family_version_id
     AND (SELECT status FROM pkb_family_versions WHERE id = OLD.family_version_id) <> 'draft' THEN
    RAISE EXCEPTION 'The attributes of an active or retired family version cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.variant_defining
     AND (SELECT cardinality FROM pkb_attribute_definitions WHERE id = NEW.definition_id) <> 'single' THEN
    RAISE EXCEPTION 'A variant-defining attribute takes one value per variant.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_family_attributes_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "pkb_family_attributes"
  FOR EACH ROW EXECUTE FUNCTION pkb_family_attributes_draft_only();
--> statement-breakpoint

-- Product and variant identity ---------------------------------------------------
CREATE TABLE "pkb_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_source" text NOT NULL DEFAULT 'listing_title',
  "family_id" uuid REFERENCES "pkb_families"("id"),
  "family_assignment" text NOT NULL DEFAULT 'unassigned',
  "family_assignment_source" text,
  "resolution_state" text NOT NULL DEFAULT 'UNRESOLVED',
  "status" text NOT NULL DEFAULT 'active',
  "merged_into_id" uuid REFERENCES "pkb_products"("id"),
  "origin" pkb_origin NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_products_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 300),
  CONSTRAINT "pkb_products_name_source_check" CHECK ("name_source" IN ('listing_title', 'manual')),
  CONSTRAINT "pkb_products_family_assignment_check" CHECK ("family_assignment" IN ('assigned', 'suggested', 'unassigned')),
  CONSTRAINT "pkb_products_family_presence_check" CHECK (("family_assignment" = 'unassigned') = ("family_id" IS NULL)),
  CONSTRAINT "pkb_products_family_source_check" CHECK (
    ("family_id" IS NULL) = ("family_assignment_source" IS NULL)
    AND ("family_assignment_source" IS NULL OR "family_assignment_source" IN ('legacy_category', 'manual', 'resolution'))),
  CONSTRAINT "pkb_products_resolution_state_check" CHECK (
    "resolution_state" IN ('VERIFIED', 'HIGH_CONFIDENCE', 'AMBIGUOUS', 'UNRESOLVED')),
  CONSTRAINT "pkb_products_status_check" CHECK ("status" IN ('active', 'merged', 'retired')),
  CONSTRAINT "pkb_products_merge_check" CHECK (
    ("status" = 'merged') = ("merged_into_id" IS NOT NULL) AND ("merged_into_id" IS NULL OR "merged_into_id" <> "id"))
);
--> statement-breakpoint
CREATE INDEX "pkb_products_family_idx" ON "pkb_products" ("family_id") WHERE "family_id" IS NOT NULL;
--> statement-breakpoint
-- A product is "assigned" only to an approved family and "suggested" only to a
-- suggested one. Checked at commit, so approving a family and its products'
-- assignments can happen in one transaction in either order.
CREATE FUNCTION pkb_products_family_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  family_status text;
BEGIN
  IF NEW.family_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT status INTO family_status FROM pkb_families WHERE id = NEW.family_id;
  IF (NEW.family_assignment = 'assigned' AND family_status <> 'approved')
     OR (NEW.family_assignment = 'suggested' AND family_status <> 'suggested') THEN
    RAISE EXCEPTION 'A product can be assigned only to an approved family, and suggested only for a suggested one.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pkb_products_family_status"
  AFTER INSERT OR UPDATE ON "pkb_products"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pkb_products_family_status();
--> statement-breakpoint
CREATE FUNCTION pkb_families_assignment_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pkb_products p
    WHERE p.family_id = NEW.id
      AND ((p.family_assignment = 'assigned' AND NEW.status <> 'approved')
        OR (p.family_assignment = 'suggested' AND NEW.status <> 'suggested'))
  ) THEN
    RAISE EXCEPTION 'Products are still assigned to this family under its previous status.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pkb_families_assignment_status"
  AFTER UPDATE OF "status" ON "pkb_families"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pkb_families_assignment_status();
--> statement-breakpoint
CREATE TABLE "pkb_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  "origin" pkb_origin NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Target of the (variant, product) foreign keys: a variant fact or identifier
  -- can only belong to a variant of the same product.
  CONSTRAINT "pkb_variants_id_product_unique" UNIQUE ("id", "pkb_product_id"),
  CONSTRAINT "pkb_variants_status_check" CHECK ("status" IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE INDEX "pkb_variants_product_idx" ON "pkb_variants" ("pkb_product_id");
--> statement-breakpoint

-- Sources, evidence and claims ------------------------------------------------------
CREATE TABLE "pkb_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Singleton system sources ("legacy:products").
  "source_key" text,
  "source_type" text NOT NULL,
  "acquisition_method" text NOT NULL,
  "authority_tier" smallint,
  "origin" pkb_origin NOT NULL,
  "usage_rights" text NOT NULL DEFAULT 'unknown',
  "url" text,
  "url_normalized" text,
  "domain" text,
  "title" text,
  "provider_key" text,
  "retrieved_at" timestamp with time zone,
  "content_sha256" text,
  "http_status" smallint,
  "robots_allowed" boolean,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_sources_source_key_unique" UNIQUE ("source_key"),
  -- No AI type exists: AI output is never a source (I-1).
  CONSTRAINT "pkb_sources_source_type_check" CHECK ("source_type" IN (
    'manufacturer_website', 'manufacturer_documentation', 'manufacturer_support', 'manufacturer_feed',
    'authorized_distributor', 'retailer', 'product_database', 'supplier_feed', 'supplier_document',
    'admin_official_document', 'staff_entry', 'public_web', 'research_provider', 'legacy_import', 'other')),
  CONSTRAINT "pkb_sources_acquisition_method_check" CHECK ("acquisition_method" IN (
    'brand_registry', 'staff_url', 'staff_upload', 'staff_entry', 'manufacturer_feed', 'supplier_feed',
    'public_mechanism', 'research_provider', 'legacy_import', 'system')),
  CONSTRAINT "pkb_sources_authority_tier_check" CHECK ("authority_tier" IS NULL OR "authority_tier" BETWEEN 1 AND 3),
  CONSTRAINT "pkb_sources_usage_rights_check" CHECK ("usage_rights" IN ('internal_only', 'display', 'exportable', 'unknown')),
  CONSTRAINT "pkb_sources_url_pair_check" CHECK (("url" IS NULL) = ("url_normalized" IS NULL)),
  CONSTRAINT "pkb_sources_url_scheme_check" CHECK ("url" IS NULL OR "url" ~* '^https?://'),
  CONSTRAINT "pkb_sources_url_required_check" CHECK (
    "acquisition_method" NOT IN ('brand_registry', 'staff_url', 'public_mechanism') OR "url" IS NOT NULL),
  CONSTRAINT "pkb_sources_sha_check" CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pkb_sources_legacy_check" CHECK (("source_type" = 'legacy_import') = ("origin" = 'UNKNOWN_LEGACY')),
  CONSTRAINT "pkb_sources_staff_check" CHECK ("source_type" <> 'staff_entry' OR "created_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_sources_document_unique" ON "pkb_sources" ("url_normalized", "content_sha256")
  NULLS NOT DISTINCT WHERE "url_normalized" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "pkb_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id"),
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "locator" text,
  "excerpt" text,
  "extraction_method" text NOT NULL,
  "extracted_label" text,
  "extracted_value" text,
  "extracted_unit" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_evidence_extraction_method_check" CHECK ("extraction_method" IN (
    'manual', 'structured_data', 'html_table', 'html_text', 'pdf_text', 'feed_field', 'rule', 'ai_assisted', 'legacy_import')),
  CONSTRAINT "pkb_evidence_lengths_check" CHECK (
    ("excerpt" IS NULL OR length("excerpt") <= 2000)
    AND ("locator" IS NULL OR length("locator") <= 500)
    AND ("extracted_value" IS NULL OR length("extracted_value") <= 4000)),
  -- AI may point at a passage of a real source; it must quote it.
  CONSTRAINT "pkb_evidence_ai_quotes_check" CHECK ("extraction_method" <> 'ai_assisted' OR "excerpt" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "pkb_evidence_product_idx" ON "pkb_evidence" ("pkb_product_id");
--> statement-breakpoint
CREATE INDEX "pkb_evidence_source_idx" ON "pkb_evidence" ("source_id");
--> statement-breakpoint
CREATE TABLE "pkb_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid,
  "target_kind" text NOT NULL,
  "definition_id" uuid REFERENCES "pkb_attribute_definitions"("id"),
  "identifier_type" text,
  "ordinal" smallint NOT NULL DEFAULT 0,
  "evidence_id" uuid NOT NULL REFERENCES "pkb_evidence"("id"),
  "value_status" pkb_value_status NOT NULL,
  "raw_value" text,
  "raw_unit" text,
  "value_text" text,
  "value_number" numeric,
  "value_number_max" numeric,
  "value_unit" text,
  "value_boolean" boolean,
  "value_date" date,
  "value_option_id" uuid,
  "value_brand_id" uuid REFERENCES "pkb_brands"("id"),
  "identifier_normalized" text,
  "status" text NOT NULL DEFAULT 'SUGGESTED',
  "proposed_by" uuid REFERENCES "users"("id"),
  "proposed_by_run" text,
  "decided_by" uuid REFERENCES "users"("id"),
  "decision_policy" text,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_claims_variant_fk" FOREIGN KEY ("pkb_variant_id", "pkb_product_id")
    REFERENCES "pkb_variants"("id", "pkb_product_id") ON DELETE CASCADE,
  CONSTRAINT "pkb_claims_option_fk" FOREIGN KEY ("value_option_id", "definition_id")
    REFERENCES "pkb_attribute_options"("id", "definition_id"),
  CONSTRAINT "pkb_claims_target_kind_check" CHECK ("target_kind" IN ('fact', 'identifier')),
  CONSTRAINT "pkb_claims_target_check" CHECK (
    ("target_kind" = 'fact') = ("definition_id" IS NOT NULL)
    AND ("target_kind" = 'identifier') = ("identifier_type" IS NOT NULL)),
  CONSTRAINT "pkb_claims_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 199),
  CONSTRAINT "pkb_claims_status_check" CHECK ("status" IN ('SUGGESTED', 'CONFLICT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  CONSTRAINT "pkb_claims_decision_check" CHECK (
    ("status" IN ('ACCEPTED', 'REJECTED')) = ("decided_at" IS NOT NULL)
    AND ("status" NOT IN ('ACCEPTED', 'REJECTED') OR "decided_by" IS NOT NULL OR "decision_policy" IS NOT NULL)),
  CONSTRAINT "pkb_claims_value_shape_check" CHECK (
    CASE "value_status"
      WHEN 'not_applicable' THEN "raw_value" IS NULL AND num_nonnulls("value_text", "value_number", "value_number_max",
        "value_unit", "value_boolean", "value_date", "value_option_id", "value_brand_id", "identifier_normalized") = 0
      WHEN 'unnormalized' THEN "raw_value" IS NOT NULL AND num_nonnulls("value_text", "value_number", "value_number_max",
        "value_unit", "value_boolean", "value_date", "value_option_id", "value_brand_id", "identifier_normalized") = 0
      ELSE "raw_value" IS NOT NULL AND num_nonnulls("value_text", "value_number", "value_boolean", "value_date",
        "value_option_id", "value_brand_id", "identifier_normalized") >= 1
    END),
  CONSTRAINT "pkb_claims_number_check" CHECK (
    ("value_number_max" IS NULL OR ("value_number" IS NOT NULL AND "value_number_max" >= "value_number"))
    AND ("value_unit" IS NULL OR "value_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "pkb_claims_product_status_idx" ON "pkb_claims" ("pkb_product_id", "status");
--> statement-breakpoint
CREATE INDEX "pkb_claims_evidence_idx" ON "pkb_claims" ("evidence_id");
--> statement-breakpoint

-- Facts -----------------------------------------------------------------------
CREATE TABLE "pkb_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid,
  "definition_id" uuid NOT NULL REFERENCES "pkb_attribute_definitions"("id"),
  "ordinal" smallint NOT NULL DEFAULT 0,
  "value_status" pkb_value_status NOT NULL,
  "raw_value" text,
  "raw_unit" text,
  "raw_label" text,
  "value_text" text,
  "value_number" numeric,
  "value_number_max" numeric,
  "value_unit" text,
  "value_boolean" boolean,
  "value_date" date,
  "value_option_id" uuid,
  "value_brand_id" uuid REFERENCES "pkb_brands"("id"),
  "verification_state" pkb_verification_state NOT NULL,
  "origin" pkb_origin NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id"),
  "claim_id" uuid REFERENCES "pkb_claims"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decision_policy" text,
  "locked_at" timestamp with time zone,
  "locked_by" uuid REFERENCES "users"("id"),
  -- The legacy column this value is mirrored from, while the listing editor
  -- still writes it (D-069, D-070). Null for knowledge-native values.
  "legacy_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_facts_variant_fk" FOREIGN KEY ("pkb_variant_id", "pkb_product_id")
    REFERENCES "pkb_variants"("id", "pkb_product_id") ON DELETE CASCADE,
  CONSTRAINT "pkb_facts_option_fk" FOREIGN KEY ("value_option_id", "definition_id")
    REFERENCES "pkb_attribute_options"("id", "definition_id"),
  CONSTRAINT "pkb_facts_slot_unique" UNIQUE NULLS NOT DISTINCT ("pkb_product_id", "pkb_variant_id", "definition_id", "ordinal"),
  CONSTRAINT "pkb_facts_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 199),
  CONSTRAINT "pkb_facts_value_shape_check" CHECK (
    CASE "value_status"
      WHEN 'not_applicable' THEN "raw_value" IS NULL AND num_nonnulls("value_text", "value_number", "value_number_max",
        "value_unit", "value_boolean", "value_date", "value_option_id", "value_brand_id") = 0
      WHEN 'unnormalized' THEN "raw_value" IS NOT NULL AND num_nonnulls("value_text", "value_number", "value_number_max",
        "value_unit", "value_boolean", "value_date", "value_option_id", "value_brand_id") = 0
      ELSE "raw_value" IS NOT NULL AND num_nonnulls("value_text", "value_number", "value_boolean", "value_date",
        "value_option_id", "value_brand_id") >= 1
    END),
  CONSTRAINT "pkb_facts_number_check" CHECK (
    ("value_number_max" IS NULL OR ("value_number" IS NOT NULL AND "value_number_max" >= "value_number"))
    AND ("value_unit" IS NULL OR "value_number" IS NOT NULL)),
  -- I-2: VERIFIED needs an accepted claim and a decision basis.
  CONSTRAINT "pkb_facts_verified_check" CHECK (
    "verification_state" <> 'VERIFIED' OR ("claim_id" IS NOT NULL AND ("decided_by" IS NOT NULL OR "decision_policy" IS NOT NULL))),
  CONSTRAINT "pkb_facts_manual_check" CHECK ("verification_state" <> 'MANUAL' OR "decided_by" IS NOT NULL),
  -- I-3: legacy values are exactly the ones of unknown origin.
  CONSTRAINT "pkb_facts_legacy_check" CHECK (("verification_state" = 'LEGACY') = ("origin" = 'UNKNOWN_LEGACY')),
  CONSTRAINT "pkb_facts_lock_check" CHECK (("locked_at" IS NULL) = ("locked_by" IS NULL)),
  CONSTRAINT "pkb_facts_legacy_ref_check" CHECK ("legacy_ref" IS NULL OR "legacy_ref" ~ '^[a-z_]+(\.[A-Za-z0-9_-]+)*$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_facts_option_unique" ON "pkb_facts" ("pkb_product_id", "pkb_variant_id", "definition_id", "value_option_id")
  NULLS NOT DISTINCT WHERE "value_option_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pkb_facts_definition_number_idx" ON "pkb_facts" ("definition_id", "value_number") WHERE "value_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pkb_facts_definition_option_idx" ON "pkb_facts" ("definition_id", "value_option_id") WHERE "value_option_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pkb_facts_brand_idx" ON "pkb_facts" ("value_brand_id") WHERE "value_brand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pkb_facts_variant_idx" ON "pkb_facts" ("pkb_variant_id") WHERE "pkb_variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pkb_facts_source_idx" ON "pkb_facts" ("source_id");
--> statement-breakpoint
CREATE INDEX "pkb_facts_claim_idx" ON "pkb_facts" ("claim_id") WHERE "claim_id" IS NOT NULL;
--> statement-breakpoint
-- A value's shape must be the one its definition asks for, and a single-valued
-- attribute has one slot. Shared by facts and fact claims.
CREATE FUNCTION pkb_check_value_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  definition record;
  ok boolean;
BEGIN
  -- Nested, so a fact row (which has no target_kind) never evaluates the field.
  IF TG_TABLE_NAME = 'pkb_claims' THEN
    IF NEW.target_kind <> 'fact' THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT key, data_type, cardinality INTO definition FROM pkb_attribute_definitions WHERE id = NEW.definition_id;
  IF definition.cardinality = 'single' AND NEW.ordinal <> 0 THEN
    RAISE EXCEPTION 'Attribute % takes a single value.', definition.key USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.value_status <> 'normalized' THEN
    RETURN NEW;
  END IF;
  ok := CASE definition.data_type
    WHEN 'text' THEN NEW.value_text IS NOT NULL AND num_nonnulls(NEW.value_number, NEW.value_unit, NEW.value_boolean,
      NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'url' THEN NEW.value_text ~* '^https?://' AND num_nonnulls(NEW.value_number, NEW.value_unit, NEW.value_boolean,
      NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'number' THEN NEW.value_number IS NOT NULL AND num_nonnulls(NEW.value_text, NEW.value_number_max, NEW.value_unit,
      NEW.value_boolean, NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'quantity' THEN NEW.value_number IS NOT NULL AND NEW.value_unit IS NOT NULL AND num_nonnulls(NEW.value_text,
      NEW.value_number_max, NEW.value_boolean, NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'quantity_range' THEN NEW.value_number IS NOT NULL AND NEW.value_number_max IS NOT NULL AND NEW.value_unit IS NOT NULL
      AND num_nonnulls(NEW.value_text, NEW.value_boolean, NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'boolean' THEN NEW.value_boolean IS NOT NULL AND num_nonnulls(NEW.value_text, NEW.value_number, NEW.value_unit,
      NEW.value_date, NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'date' THEN NEW.value_date IS NOT NULL AND num_nonnulls(NEW.value_number, NEW.value_unit, NEW.value_boolean,
      NEW.value_option_id, NEW.value_brand_id) = 0
    WHEN 'enum' THEN NEW.value_option_id IS NOT NULL AND num_nonnulls(NEW.value_text, NEW.value_number, NEW.value_unit,
      NEW.value_boolean, NEW.value_date, NEW.value_brand_id) = 0
    WHEN 'brand' THEN NEW.value_brand_id IS NOT NULL AND num_nonnulls(NEW.value_text, NEW.value_number, NEW.value_unit,
      NEW.value_boolean, NEW.value_date, NEW.value_option_id) = 0
    ELSE false
  END;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'The value does not have the shape attribute % (%) needs.', definition.key, definition.data_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_facts_value_definition"
  BEFORE INSERT OR UPDATE ON "pkb_facts"
  FOR EACH ROW EXECUTE FUNCTION pkb_check_value_definition();
--> statement-breakpoint
CREATE TRIGGER "pkb_claims_value_definition"
  BEFORE INSERT OR UPDATE ON "pkb_claims"
  FOR EACH ROW EXECUTE FUNCTION pkb_check_value_definition();
--> statement-breakpoint
-- A definition's key is permanent, and its type cannot change under stored values.
CREATE FUNCTION pkb_attribute_definitions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'An attribute key is permanent (%).', OLD.key USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.data_type, NEW.cardinality, NEW.unit_dimension) IS DISTINCT FROM (OLD.data_type, OLD.cardinality, OLD.unit_dimension)
     AND (EXISTS (SELECT 1 FROM pkb_facts WHERE definition_id = OLD.id)
       OR EXISTS (SELECT 1 FROM pkb_claims WHERE definition_id = OLD.id)) THEN
    RAISE EXCEPTION 'Attribute % has stored values, so its type, cardinality and unit dimension cannot change.', OLD.key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_attribute_definitions_guard"
  BEFORE UPDATE ON "pkb_attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION pkb_attribute_definitions_guard();
--> statement-breakpoint
CREATE TABLE "pkb_fact_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fact_id" uuid NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid,
  "definition_id" uuid NOT NULL REFERENCES "pkb_attribute_definitions"("id"),
  "change_kind" text NOT NULL,
  -- Snapshots of the fact row: an append-only audit record, never queried by value.
  "before" jsonb,
  "after" jsonb,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_fact_history_change_kind_check" CHECK ("change_kind" IN
    ('created', 'updated', 'cleared', 'locked', 'unlocked', 'restored')),
  CONSTRAINT "pkb_fact_history_snapshots_check" CHECK (
    ("change_kind" = 'created') = ("before" IS NULL) AND ("change_kind" = 'cleared') = ("after" IS NULL)),
  CONSTRAINT "pkb_fact_history_reason_check" CHECK (length("reason") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX "pkb_fact_history_product_idx" ON "pkb_fact_history" ("pkb_product_id", "created_at");
--> statement-breakpoint
CREATE INDEX "pkb_fact_history_fact_idx" ON "pkb_fact_history" ("fact_id", "created_at");
--> statement-breakpoint
-- Append-only. A delete is allowed only as the cascade of removing the whole
-- product record (pg_trigger_depth counts the foreign-key trigger).
CREATE FUNCTION pkb_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pkb_fact_history_append_only"
  BEFORE UPDATE OR DELETE ON "pkb_fact_history"
  FOR EACH ROW EXECUTE FUNCTION pkb_append_only();
--> statement-breakpoint

-- Identifiers -------------------------------------------------------------------
CREATE TABLE "pkb_identifiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid,
  "identifier_type" text NOT NULL,
  "value_raw" text NOT NULL,
  "value_normalized" text,
  "gtin14" text,
  "validation_status" text NOT NULL,
  "verification_state" pkb_verification_state NOT NULL,
  "origin" pkb_origin NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id"),
  "claim_id" uuid REFERENCES "pkb_claims"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decision_policy" text,
  "locked_at" timestamp with time zone,
  "locked_by" uuid REFERENCES "users"("id"),
  "legacy_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_identifiers_variant_fk" FOREIGN KEY ("pkb_variant_id", "pkb_product_id")
    REFERENCES "pkb_variants"("id", "pkb_product_id") ON DELETE CASCADE,
  CONSTRAINT "pkb_identifiers_type_check" CHECK ("identifier_type" IN
    ('gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn10', 'isbn13', 'mpn', 'model_number', 'asin', 'other')),
  CONSTRAINT "pkb_identifiers_validation_check" CHECK ("validation_status" IN ('valid', 'invalid', 'unchecked')),
  CONSTRAINT "pkb_identifiers_normalized_check" CHECK (("validation_status" = 'invalid') = ("value_normalized" IS NULL)),
  CONSTRAINT "pkb_identifiers_gtin_check" CHECK (
    ("gtin14" IS NOT NULL) = ("validation_status" = 'valid'
      AND "identifier_type" IN ('gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn10', 'isbn13'))
    AND ("gtin14" IS NULL OR "gtin14" ~ '^[0-9]{14}$')),
  CONSTRAINT "pkb_identifiers_raw_check" CHECK (length("value_raw") BETWEEN 1 AND 64),
  CONSTRAINT "pkb_identifiers_verified_check" CHECK (
    "verification_state" <> 'VERIFIED' OR ("claim_id" IS NOT NULL AND ("decided_by" IS NOT NULL OR "decision_policy" IS NOT NULL))),
  CONSTRAINT "pkb_identifiers_manual_check" CHECK ("verification_state" <> 'MANUAL' OR "decided_by" IS NOT NULL),
  CONSTRAINT "pkb_identifiers_legacy_check" CHECK (("verification_state" = 'LEGACY') = ("origin" = 'UNKNOWN_LEGACY')),
  CONSTRAINT "pkb_identifiers_lock_check" CHECK (("locked_at" IS NULL) = ("locked_by" IS NULL)),
  CONSTRAINT "pkb_identifiers_legacy_ref_check" CHECK ("legacy_ref" IS NULL OR "legacy_ref" ~ '^[a-z_]+(\.[A-Za-z0-9_-]+)*$')
);
--> statement-breakpoint
-- One trade item, one record: a GTIN is stored against one product at most.
CREATE UNIQUE INDEX "pkb_identifiers_gtin_unique" ON "pkb_identifiers" ("gtin14") WHERE "gtin14" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_identifiers_value_unique" ON "pkb_identifiers"
  ("pkb_product_id", "pkb_variant_id", "identifier_type", (coalesce("value_normalized", "value_raw"))) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "pkb_identifiers_lookup_idx" ON "pkb_identifiers" ("identifier_type", "value_normalized")
  WHERE "value_normalized" IS NOT NULL;
--> statement-breakpoint

-- Relationships -------------------------------------------------------------------
CREATE TABLE "pkb_relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "to_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "verification_state" pkb_verification_state NOT NULL,
  "origin" pkb_origin NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id"),
  "claim_id" uuid REFERENCES "pkb_claims"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decision_policy" text,
  "locked_at" timestamp with time zone,
  "locked_by" uuid REFERENCES "users"("id"),
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_relationships_unique" UNIQUE ("from_product_id", "to_product_id", "kind"),
  CONSTRAINT "pkb_relationships_self_check" CHECK ("from_product_id" <> "to_product_id"),
  CONSTRAINT "pkb_relationships_kind_check" CHECK ("kind" IN (
    'accessory_for', 'compatible_with', 'successor_of', 'replacement_for', 'bundle_contains', 'requires',
    'related_to', 'same_series')),
  -- Symmetric kinds are stored once, in id order.
  CONSTRAINT "pkb_relationships_symmetric_check" CHECK (
    "kind" NOT IN ('related_to', 'same_series') OR "from_product_id" < "to_product_id"),
  CONSTRAINT "pkb_relationships_verified_check" CHECK (
    "verification_state" <> 'VERIFIED' OR ("claim_id" IS NOT NULL AND ("decided_by" IS NOT NULL OR "decision_policy" IS NOT NULL))),
  CONSTRAINT "pkb_relationships_manual_check" CHECK ("verification_state" <> 'MANUAL' OR "decided_by" IS NOT NULL),
  CONSTRAINT "pkb_relationships_legacy_check" CHECK (("verification_state" = 'LEGACY') = ("origin" = 'UNKNOWN_LEGACY')),
  CONSTRAINT "pkb_relationships_lock_check" CHECK (("locked_at" IS NULL) = ("locked_by" IS NULL)),
  CONSTRAINT "pkb_relationships_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);
--> statement-breakpoint
CREATE INDEX "pkb_relationships_to_idx" ON "pkb_relationships" ("to_product_id", "kind");
--> statement-breakpoint

-- Aliases -------------------------------------------------------------------------
CREATE TABLE "pkb_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_kind" text NOT NULL,
  "brand_id" uuid REFERENCES "pkb_brands"("id") ON DELETE CASCADE,
  "pkb_product_id" uuid REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid REFERENCES "pkb_variants"("id") ON DELETE CASCADE,
  "family_id" uuid REFERENCES "pkb_families"("id") ON DELETE CASCADE,
  "definition_id" uuid REFERENCES "pkb_attribute_definitions"("id") ON DELETE CASCADE,
  "option_id" uuid,
  "alias" text NOT NULL,
  "alias_normalized" text NOT NULL,
  "alias_kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  "source_id" uuid REFERENCES "pkb_sources"("id"),
  "evidence_note" text,
  "created_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_aliases_option_fk" FOREIGN KEY ("option_id", "definition_id")
    REFERENCES "pkb_attribute_options"("id", "definition_id") ON DELETE CASCADE,
  CONSTRAINT "pkb_aliases_target_check" CHECK (CASE "target_kind"
    WHEN 'brand' THEN "brand_id" IS NOT NULL AND num_nonnulls("pkb_product_id", "pkb_variant_id", "family_id", "definition_id", "option_id") = 0
    WHEN 'product' THEN "pkb_product_id" IS NOT NULL AND num_nonnulls("brand_id", "pkb_variant_id", "family_id", "definition_id", "option_id") = 0
    WHEN 'variant' THEN "pkb_variant_id" IS NOT NULL AND num_nonnulls("brand_id", "pkb_product_id", "family_id", "definition_id", "option_id") = 0
    WHEN 'family' THEN "family_id" IS NOT NULL AND num_nonnulls("brand_id", "pkb_product_id", "pkb_variant_id", "definition_id", "option_id") = 0
    WHEN 'definition' THEN "definition_id" IS NOT NULL AND num_nonnulls("brand_id", "pkb_product_id", "pkb_variant_id", "family_id", "option_id") = 0
    WHEN 'option' THEN "option_id" IS NOT NULL AND "definition_id" IS NOT NULL
      AND num_nonnulls("brand_id", "pkb_product_id", "pkb_variant_id", "family_id") = 0
    ELSE false
  END),
  CONSTRAINT "pkb_aliases_kind_check" CHECK ("alias_kind" IN (
    'spelling_variant', 'abbreviation', 'model_formatting', 'common_name', 'former_name', 'misspelling', 'translation', 'other')),
  CONSTRAINT "pkb_aliases_status_check" CHECK ("status" IN ('suggested', 'approved', 'rejected')),
  CONSTRAINT "pkb_aliases_decision_check" CHECK (("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)),
  CONSTRAINT "pkb_aliases_alias_check" CHECK (length(btrim("alias")) BETWEEN 1 AND 120 AND length("alias_normalized") >= 1),
  CONSTRAINT "pkb_aliases_note_check" CHECK ("evidence_note" IS NULL OR length("evidence_note") <= 500)
);
--> statement-breakpoint
-- An approved alias means one thing: unique per kind (options: per attribute).
CREATE UNIQUE INDEX "pkb_aliases_approved_unique" ON "pkb_aliases"
  ("target_kind", (CASE WHEN "target_kind" = 'option' THEN "definition_id" END), "alias_normalized")
  NULLS NOT DISTINCT WHERE "status" = 'approved';
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_aliases_target_unique" ON "pkb_aliases"
  ("target_kind", (coalesce("option_id", "brand_id", "pkb_product_id", "pkb_variant_id", "family_id", "definition_id")), "alias_normalized");
--> statement-breakpoint

-- Legacy bridge ---------------------------------------------------------------------
-- Which attribute definition mirrors each category specification (D-025 to D-064).
CREATE TABLE "pkb_legacy_attribute_map" (
  "category_attribute_id" uuid PRIMARY KEY REFERENCES "category_attributes"("id") ON DELETE CASCADE,
  "definition_id" uuid NOT NULL REFERENCES "pkb_attribute_definitions"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "pkb_legacy_attribute_map_definition_idx" ON "pkb_legacy_attribute_map" ("definition_id");
--> statement-breakpoint
-- Legacy values the knowledge base could not place without guessing: a
-- specification row with no matching attribute, an option with no definition,
-- a value that collides with a structured one. Staff map or dismiss them.
CREATE TABLE "pkb_unmapped_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "variant_id" uuid REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "legacy_ref" text NOT NULL,
  "label" text,
  "value" text NOT NULL,
  "entry_key" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_unmapped_values_entry_unique" UNIQUE ("product_id", "entry_key"),
  CONSTRAINT "pkb_unmapped_values_reason_check" CHECK ("reason" IN (
    'no_matching_definition', 'ambiguous_label', 'multi_value_label', 'option_without_definition',
    'duplicate_of_structured_value', 'conflicts_with_structured_value', 'differs_from_knowledge_value',
    'identifier_in_use', 'invalid_identifier', 'unattributed_change_not_applied', 'differs_from_locked_value')),
  CONSTRAINT "pkb_unmapped_values_status_check" CHECK ("status" IN ('open', 'dismissed')),
  CONSTRAINT "pkb_unmapped_values_decision_check" CHECK (("status" = 'dismissed') = ("decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "pkb_unmapped_values_open_idx" ON "pkb_unmapped_values" ("reason", "created_at") WHERE "status" = 'open';
--> statement-breakpoint
-- Listings whose knowledge must be re-read from their legacy columns.
CREATE TABLE "pkb_sync_queue" (
  "product_id" uuid PRIMARY KEY REFERENCES "products"("id") ON DELETE CASCADE,
  "queued_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "attempts" integer NOT NULL DEFAULT 0,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "last_error" text
);
--> statement-breakpoint
CREATE INDEX "pkb_sync_queue_due_idx" ON "pkb_sync_queue" ("queued_at");
--> statement-breakpoint

-- Links from the commerce tables -----------------------------------------------------
ALTER TABLE "products" ADD COLUMN "pkb_product_id" uuid REFERENCES "pkb_products"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "products_pkb_product_id_idx" ON "products" ("pkb_product_id") WHERE "pkb_product_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "pkb_variant_id" uuid REFERENCES "pkb_variants"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "product_variants_pkb_variant_id_idx" ON "product_variants" ("pkb_variant_id") WHERE "pkb_variant_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "attributes" ADD COLUMN "attribute_definition_id" uuid REFERENCES "pkb_attribute_definitions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "default_family_id" uuid REFERENCES "pkb_families"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- What queues a listing ---------------------------------------------------------------
CREATE FUNCTION pkb_queue_listings(ids uuid[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO pkb_sync_queue (product_id)
  SELECT DISTINCT t.id FROM unnest(ids) AS t(id)
  WHERE t.id IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = t.id)
  ON CONFLICT (product_id) DO UPDATE
    SET queued_at = clock_timestamp(), claimed_at = NULL, claimed_by = NULL
$$;
--> statement-breakpoint
CREATE FUNCTION pkb_touch_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pkb_queue_listings(ARRAY[NEW.id]);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "products_pkb_insert"
  AFTER INSERT ON "products"
  FOR EACH ROW EXECUTE FUNCTION pkb_touch_product();
--> statement-breakpoint
-- Only the columns the knowledge base mirrors; status, price and SEO text do not.
CREATE TRIGGER "products_pkb_update"
  AFTER UPDATE ON "products"
  FOR EACH ROW WHEN (
    OLD.title IS DISTINCT FROM NEW.title
    OR OLD.brand IS DISTINCT FROM NEW.brand
    OR OLD.identifier_type IS DISTINCT FROM NEW.identifier_type
    OR OLD.identifier_value IS DISTINCT FROM NEW.identifier_value
    OR OLD.details IS DISTINCT FROM NEW.details
    OR OLD.attribute_values IS DISTINCT FROM NEW.attribute_values
    OR OLD.spec_table IS DISTINCT FROM NEW.spec_table
    OR OLD.measurements IS DISTINCT FROM NEW.measurements
    OR OLD.box_contents IS DISTINCT FROM NEW.box_contents
    OR OLD.compliance IS DISTINCT FROM NEW.compliance
    OR OLD.category_id IS DISTINCT FROM NEW.category_id
  )
  EXECUTE FUNCTION pkb_touch_product();
--> statement-breakpoint
CREATE FUNCTION pkb_touch_variant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pkb_queue_listings(ARRAY[OLD.product_id]);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM pkb_queue_listings(ARRAY[NEW.product_id]);
  ELSE
    PERFORM pkb_queue_listings(ARRAY[OLD.product_id, NEW.product_id]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Not the price, stock or capacity columns: checkout must never pay for this.
CREATE TRIGGER "product_variants_pkb_change"
  AFTER INSERT OR DELETE ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION pkb_touch_variant();
--> statement-breakpoint
CREATE TRIGGER "product_variants_pkb_move"
  AFTER UPDATE ON "product_variants"
  FOR EACH ROW WHEN (OLD.product_id IS DISTINCT FROM NEW.product_id)
  EXECUTE FUNCTION pkb_touch_variant();
--> statement-breakpoint
CREATE FUNCTION pkb_touch_option_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  variant_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    variant_ids := ARRAY[NEW.variant_id];
  ELSIF TG_OP = 'DELETE' THEN
    variant_ids := ARRAY[OLD.variant_id];
  ELSE
    variant_ids := ARRAY[OLD.variant_id, NEW.variant_id];
  END IF;
  PERFORM pkb_queue_listings(ARRAY(SELECT v.product_id FROM product_variants v WHERE v.id = ANY(variant_ids)));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "variant_option_values_pkb_change"
  AFTER INSERT OR UPDATE OR DELETE ON "variant_option_values"
  FOR EACH ROW EXECUTE FUNCTION pkb_touch_option_value();
--> statement-breakpoint
CREATE FUNCTION pkb_touch_attribute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pkb_queue_listings(ARRAY(
    SELECT DISTINCT v.product_id FROM variant_option_values vov
    JOIN product_variants v ON v.id = vov.variant_id
    WHERE vov.attribute_id = NEW.id
  ) || ARRAY[NEW.product_id]);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "attributes_pkb_rename"
  AFTER UPDATE ON "attributes"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION pkb_touch_attribute();
--> statement-breakpoint
CREATE FUNCTION pkb_touch_attribute_value() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pkb_queue_listings(ARRAY(
    SELECT DISTINCT v.product_id FROM variant_option_values vov
    JOIN product_variants v ON v.id = vov.variant_id
    WHERE vov.attribute_value_id = NEW.id
  ));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "attribute_values_pkb_rename"
  AFTER UPDATE ON "attribute_values"
  FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION pkb_touch_attribute_value();
--> statement-breakpoint
-- A shelf moved changes which family everything beneath it falls under.
CREATE FUNCTION pkb_touch_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pkb_queue_listings(ARRAY(
    WITH RECURSIVE subtree AS (
      SELECT NEW.id AS id, 0 AS depth
      UNION ALL
      SELECT c.id, s.depth + 1 FROM categories c JOIN subtree s ON c.parent_id = s.id WHERE s.depth < 16
    )
    SELECT p.id FROM products p WHERE p.category_id IN (SELECT id FROM subtree)
  ));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "categories_pkb_move"
  AFTER UPDATE ON "categories"
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION pkb_touch_category();
--> statement-breakpoint

-- Every existing listing is imported by the sync job or `npm run pkb:backfill`.
INSERT INTO "pkb_sync_queue" ("product_id") SELECT "id" FROM "products" ON CONFLICT DO NOTHING;
