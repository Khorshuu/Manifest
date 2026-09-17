-- Product intelligence (docs/KNOWLEDGE_PLATFORM.md Stage 3, DECISIONS.md D-071 to D-076).
--
--  * Brand existence is separated from source trust (A-9): catalogue brands
--    are simply `active`; trust lives in the source registry and in brand
--    relations, and every trust assertion starts `suggested`.
--  * Verification policies decide which evidence may support VERIFIED (A-4).
--  * Reviewed label mappings make unmatched specification labels map
--    deterministically once staff decide (A-8).
--  * Attribute discovery proposals, identifier history (R-6), retrieved source
--    documents, enrichment runs, and product identity resolution.
--
-- Trust decisions are human: an approved registry entry, brand relation or
-- label mapping records who decided.

-- Brands: existence, not trust ------------------------------------------------
ALTER TABLE "pkb_brands" DROP CONSTRAINT "pkb_brands_decision_check";
--> statement-breakpoint
ALTER TABLE "pkb_brands" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pkb_brands" ALTER COLUMN "status" TYPE text
  USING (CASE "status"::text WHEN 'retired' THEN 'retired' ELSE 'active' END);
--> statement-breakpoint
ALTER TABLE "pkb_brands" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "pkb_brands" ADD COLUMN "merged_into_id" uuid REFERENCES "pkb_brands"("id");
--> statement-breakpoint
ALTER TABLE "pkb_brands" ADD CONSTRAINT "pkb_brands_status_check" CHECK ("status" IN ('active', 'merged', 'retired'));
--> statement-breakpoint
ALTER TABLE "pkb_brands" ADD CONSTRAINT "pkb_brands_merge_check" CHECK (
  ("status" = 'merged') = ("merged_into_id" IS NOT NULL) AND ("merged_into_id" IS NULL OR "merged_into_id" <> "id"));
--> statement-breakpoint

-- Source registry: which domains and providers are trusted, for whom --------------
CREATE TABLE "pkb_source_registry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Null: applies to every brand (a trusted retailer, a blocked domain).
  "brand_id" uuid REFERENCES "pkb_brands"("id") ON DELETE CASCADE,
  "match_kind" text NOT NULL,
  "domain" text,
  "path_prefix" text,
  "provider_key" text,
  "role" text NOT NULL,
  "authority_tier" smallint,
  -- Lower is preferred among sources of the same tier.
  "preference" smallint NOT NULL DEFAULT 100,
  -- An optional deterministic product address: {model_key}, {model}, {mpn}, {gtin}.
  "url_template" text,
  "status" text NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  "evidence_source_id" uuid REFERENCES "pkb_sources"("id") ON DELETE SET NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_source_registry_match_check" CHECK (
    "match_kind" IN ('domain', 'provider')
    AND ("match_kind" = 'domain') = ("domain" IS NOT NULL)
    AND ("match_kind" = 'provider') = ("provider_key" IS NOT NULL)),
  CONSTRAINT "pkb_source_registry_domain_check" CHECK (
    "domain" IS NULL OR "domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  CONSTRAINT "pkb_source_registry_path_check" CHECK ("path_prefix" IS NULL OR ("path_prefix" ~ '^/' AND "match_kind" = 'domain')),
  CONSTRAINT "pkb_source_registry_role_check" CHECK ("role" IN (
    'official_product', 'official_support', 'official_documentation', 'manufacturer_feed',
    'authorized_distributor', 'trusted_retailer', 'product_database', 'supplier_feed',
    'approved_secondary', 'blocked')),
  -- The tier follows from the role, so a role can never claim more authority than it has.
  CONSTRAINT "pkb_source_registry_tier_check" CHECK ("authority_tier" IS NOT DISTINCT FROM (CASE
    WHEN "role" IN ('official_product', 'official_support', 'official_documentation', 'manufacturer_feed') THEN 1
    WHEN "role" IN ('authorized_distributor', 'trusted_retailer', 'product_database', 'supplier_feed') THEN 2
    WHEN "role" = 'approved_secondary' THEN 3
    ELSE NULL END)),
  CONSTRAINT "pkb_source_registry_template_check" CHECK (
    "url_template" IS NULL OR ("url_template" ~* '^https://' AND "match_kind" = 'domain' AND "role" <> 'blocked')),
  CONSTRAINT "pkb_source_registry_status_check" CHECK ("status" IN ('suggested', 'approved', 'rejected', 'retired')),
  -- Trust is decided by a person.
  CONSTRAINT "pkb_source_registry_decision_check" CHECK (
    ("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)
    AND ("status" NOT IN ('approved', 'rejected') OR "decided_by" IS NOT NULL)),
  CONSTRAINT "pkb_source_registry_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_source_registry_entry_unique" ON "pkb_source_registry"
  ("brand_id", "match_kind", "domain", "path_prefix", "provider_key", "role") NULLS NOT DISTINCT
  WHERE "status" IN ('suggested', 'approved');
--> statement-breakpoint
CREATE INDEX "pkb_source_registry_domain_idx" ON "pkb_source_registry" ("domain") WHERE "domain" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "pkb_brand_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brand_id" uuid NOT NULL REFERENCES "pkb_brands"("id") ON DELETE CASCADE,
  "related_brand_id" uuid NOT NULL REFERENCES "pkb_brands"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'suggested',
  "origin" pkb_origin NOT NULL,
  "evidence_source_id" uuid REFERENCES "pkb_sources"("id") ON DELETE SET NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id"),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_brand_relations_unique" UNIQUE ("brand_id", "related_brand_id", "kind"),
  CONSTRAINT "pkb_brand_relations_self_check" CHECK ("brand_id" <> "related_brand_id"),
  CONSTRAINT "pkb_brand_relations_kind_check" CHECK ("kind" IN ('manufactured_by', 'subsidiary_of', 'formerly_known_as')),
  CONSTRAINT "pkb_brand_relations_status_check" CHECK ("status" IN ('suggested', 'approved', 'rejected', 'retired')),
  CONSTRAINT "pkb_brand_relations_decision_check" CHECK (
    ("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)
    AND ("status" NOT IN ('approved', 'rejected') OR "decided_by" IS NOT NULL))
);
--> statement-breakpoint

-- Verification policies (A-4) --------------------------------------------------------
CREATE TABLE "pkb_verification_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "applies_to" text NOT NULL DEFAULT 'any',
  -- Narrow a policy to a family (and its descendants) or one attribute; both null = everywhere.
  "family_id" uuid REFERENCES "pkb_families"("id") ON DELETE CASCADE,
  "definition_id" uuid REFERENCES "pkb_attribute_definitions"("id") ON DELETE CASCADE,
  "qualifying_source_types" text[] NOT NULL,
  -- When set, a source counts only if it matches an APPROVED registry entry with one of these roles.
  "registry_roles" text[],
  "max_authority_tier" smallint,
  "min_independent_sources" smallint NOT NULL DEFAULT 1,
  "allow_ai_assisted" boolean NOT NULL DEFAULT false,
  "origin" pkb_origin NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "activated_by" uuid REFERENCES "users"("id"),
  "activated_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_verification_policies_key_unique" UNIQUE ("key"),
  CONSTRAINT "pkb_verification_policies_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT "pkb_verification_policies_status_check" CHECK ("status" IN ('draft', 'active', 'retired')),
  CONSTRAINT "pkb_verification_policies_applies_check" CHECK ("applies_to" IN ('fact', 'identifier', 'any')),
  CONSTRAINT "pkb_verification_policies_types_check" CHECK (cardinality("qualifying_source_types") >= 1
    AND NOT ('legacy_import' = ANY("qualifying_source_types")) AND NOT ('staff_entry' = ANY("qualifying_source_types"))),
  CONSTRAINT "pkb_verification_policies_tier_check" CHECK ("max_authority_tier" IS NULL OR "max_authority_tier" BETWEEN 1 AND 3),
  CONSTRAINT "pkb_verification_policies_min_check" CHECK ("min_independent_sources" BETWEEN 1 AND 5),
  CONSTRAINT "pkb_verification_policies_activation_check" CHECK (("status" = 'draft') = ("activated_at" IS NULL))
);
--> statement-breakpoint
-- The starting policies are created by lib/pkb/policies.ts (ensureDefaultPolicies),
-- so a database reset re-creates them and a retired policy stays retired.

-- Reviewed label mappings (A-8) -----------------------------------------------------
CREATE TABLE "pkb_label_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "label_normalized" text NOT NULL,
  -- Where the label was written: a listing's specification or measurement table,
  -- a variant option name, a retrieved source document, or anywhere.
  "context" text NOT NULL,
  -- The same label can mean different things in different families ("Weight").
  "family_id" uuid REFERENCES "pkb_families"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "definition_id" uuid REFERENCES "pkb_attribute_definitions"("id"),
  "status" text NOT NULL DEFAULT 'approved',
  "note" text,
  "decided_by" uuid NOT NULL REFERENCES "users"("id"),
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_label_mappings_context_check" CHECK ("context" IN ('spec_table', 'measurements', 'variant_option', 'source_document', 'any')),
  CONSTRAINT "pkb_label_mappings_action_check" CHECK ("action" IN ('map', 'ignore') AND ("action" = 'map') = ("definition_id" IS NOT NULL)),
  CONSTRAINT "pkb_label_mappings_status_check" CHECK ("status" IN ('approved', 'retired')),
  CONSTRAINT "pkb_label_mappings_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 200 AND length("label_normalized") >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_label_mappings_approved_unique" ON "pkb_label_mappings"
  ("label_normalized", "context", "family_id") NULLS NOT DISTINCT WHERE "status" = 'approved';
--> statement-breakpoint

-- Identifier history (R-6) ------------------------------------------------------------
CREATE TABLE "pkb_identifier_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identifier_id" uuid NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "pkb_variant_id" uuid,
  "identifier_type" text NOT NULL,
  "change_kind" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "source_id" uuid REFERENCES "pkb_sources"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_identifier_history_change_kind_check" CHECK ("change_kind" IN ('created', 'updated', 'cleared', 'locked', 'unlocked')),
  CONSTRAINT "pkb_identifier_history_snapshots_check" CHECK (
    ("change_kind" = 'created') = ("before" IS NULL) AND ("change_kind" = 'cleared') = ("after" IS NULL)),
  CONSTRAINT "pkb_identifier_history_reason_check" CHECK (length("reason") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX "pkb_identifier_history_identifier_idx" ON "pkb_identifier_history" ("identifier_id", "created_at");
--> statement-breakpoint
CREATE INDEX "pkb_identifier_history_product_idx" ON "pkb_identifier_history" ("pkb_product_id", "created_at");
--> statement-breakpoint
CREATE TRIGGER "pkb_identifier_history_append_only"
  BEFORE UPDATE OR DELETE ON "pkb_identifier_history"
  FOR EACH ROW EXECUTE FUNCTION pkb_append_only();
--> statement-breakpoint
-- Identifiers recorded before history existed get their starting point.
INSERT INTO "pkb_identifier_history"
  ("identifier_id", "pkb_product_id", "pkb_variant_id", "identifier_type", "change_kind", "before", "after", "actor_user_id", "source_id", "reason", "created_at")
SELECT i."id", i."pkb_product_id", i."pkb_variant_id", i."identifier_type", 'created', NULL, to_jsonb(i), NULL, i."source_id",
       'Recorded before identifier history existed.', i."created_at"
FROM "pkb_identifiers" i;
--> statement-breakpoint

-- Enrichment runs and retrieved documents -----------------------------------------------
CREATE TABLE "pkb_enrichment_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "request_key" text NOT NULL,
  "requested_by" uuid REFERENCES "users"("id"),
  "resolution_state" text,
  "blocked_reason" text,
  -- [{ provider, status: OK | NOT_CONFIGURED | UNAVAILABLE | FAILED, message }], bounded by code.
  "providers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "documents_retrieved" integer NOT NULL DEFAULT 0,
  "documents_refused" integer NOT NULL DEFAULT 0,
  "claims_proposed" integer NOT NULL DEFAULT 0,
  "conflicts" integer NOT NULL DEFAULT 0,
  "proposals_created" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "pkb_enrichment_runs_request_key_unique" UNIQUE ("request_key"),
  CONSTRAINT "pkb_enrichment_runs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'blocked', 'failed')),
  CONSTRAINT "pkb_enrichment_runs_providers_check" CHECK (jsonb_typeof("providers") = 'array')
);
--> statement-breakpoint
-- One run at a time per product.
CREATE UNIQUE INDEX "pkb_enrichment_runs_active_unique" ON "pkb_enrichment_runs" ("pkb_product_id")
  WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "pkb_enrichment_runs_product_idx" ON "pkb_enrichment_runs" ("pkb_product_id", "created_at");
--> statement-breakpoint
CREATE TABLE "pkb_source_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id") ON DELETE CASCADE,
  "pkb_product_id" uuid REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "pkb_enrichment_runs"("id") ON DELETE SET NULL,
  -- retrieved: fetched now; provided: pasted or uploaded by staff; refused: not fetched and why; failed.
  "status" text NOT NULL,
  "refusal_reason" text,
  "http_status" smallint,
  "content_type" text,
  "byte_size" integer,
  "sha256" text,
  "text_content" text,
  -- JSON-LD objects found in the document, bounded by code.
  "structured_data" jsonb,
  "identity_match" text NOT NULL DEFAULT 'not_checked',
  "identity_notes" jsonb,
  "created_by" uuid REFERENCES "users"("id"),
  "retrieved_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_source_documents_status_check" CHECK ("status" IN ('retrieved', 'provided', 'refused', 'failed')),
  CONSTRAINT "pkb_source_documents_content_check" CHECK (
    ("status" IN ('retrieved', 'provided')) = ("text_content" IS NOT NULL)
    AND ("text_content" IS NULL OR length("text_content") <= 500000)),
  CONSTRAINT "pkb_source_documents_reason_check" CHECK (("status" IN ('refused', 'failed')) = ("refusal_reason" IS NOT NULL)),
  CONSTRAINT "pkb_source_documents_identity_check" CHECK ("identity_match" IN ('match', 'mismatch', 'unknown', 'not_checked')),
  CONSTRAINT "pkb_source_documents_sha_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "pkb_source_documents_source_idx" ON "pkb_source_documents" ("source_id", "retrieved_at");
--> statement-breakpoint
CREATE INDEX "pkb_source_documents_product_idx" ON "pkb_source_documents" ("pkb_product_id", "retrieved_at");
--> statement-breakpoint
ALTER TABLE "pkb_evidence" ADD COLUMN "document_id" uuid REFERENCES "pkb_source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Sources staff attached to a product, to be read on its next research run.
CREATE TABLE "pkb_product_sources" (
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "pkb_sources"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("pkb_product_id", "source_id")
);
--> statement-breakpoint

-- Attribute discovery ----------------------------------------------------------------------
CREATE TABLE "pkb_attribute_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "label_normalized" text NOT NULL,
  "example_value" text NOT NULL,
  "data_type" text NOT NULL,
  "cardinality" text NOT NULL DEFAULT 'single',
  "unit_dimension" text,
  "display_unit" text,
  "searchable" boolean NOT NULL DEFAULT true,
  "filterable" boolean NOT NULL DEFAULT false,
  "variant_defining" boolean NOT NULL DEFAULT false,
  "seo_relevant" boolean NOT NULL DEFAULT false,
  "evidence_id" uuid NOT NULL REFERENCES "pkb_evidence"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'open',
  "family_id" uuid REFERENCES "pkb_families"("id"),
  "definition_id" uuid REFERENCES "pkb_attribute_definitions"("id"),
  "claim_id" uuid REFERENCES "pkb_claims"("id") ON DELETE SET NULL,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_attribute_proposals_status_check" CHECK ("status" IN ('open', 'added_to_family', 'product_only', 'ignored')),
  CONSTRAINT "pkb_attribute_proposals_decision_check" CHECK (
    ("status" = 'open') = ("decided_at" IS NULL) AND ("status" = 'open' OR "decided_by" IS NOT NULL)),
  CONSTRAINT "pkb_attribute_proposals_data_type_check" CHECK ("data_type" IN
    ('text', 'number', 'quantity', 'quantity_range', 'boolean', 'enum', 'date', 'url', 'brand')),
  CONSTRAINT "pkb_attribute_proposals_unit_check" CHECK (
    ("data_type" IN ('quantity', 'quantity_range')) = ("unit_dimension" IS NOT NULL)),
  CONSTRAINT "pkb_attribute_proposals_family_check" CHECK ("status" <> 'added_to_family' OR ("family_id" IS NOT NULL AND "definition_id" IS NOT NULL)),
  CONSTRAINT "pkb_attribute_proposals_lengths_check" CHECK (length("label") <= 200 AND length("example_value") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pkb_attribute_proposals_open_unique" ON "pkb_attribute_proposals" ("pkb_product_id", "label_normalized")
  WHERE "status" = 'open';
--> statement-breakpoint

-- Product identity resolution ------------------------------------------------------------------
ALTER TABLE "pkb_products" ADD COLUMN "resolution_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pkb_products" ADD COLUMN "resolution_reasons" jsonb;
--> statement-breakpoint
ALTER TABLE "pkb_products" ADD COLUMN "resolution_decided_by" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "pkb_products" ADD COLUMN "resolution_decided_at" timestamp with time zone;
--> statement-breakpoint
-- VERIFIED identity is only ever a person's decision.
ALTER TABLE "pkb_products" ADD CONSTRAINT "pkb_products_resolution_decision_check" CHECK (
  "resolution_state" <> 'VERIFIED' OR ("resolution_decided_by" IS NOT NULL AND "resolution_decided_at" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE "pkb_resolution_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pkb_product_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "from_state" text,
  "to_state" text NOT NULL,
  "reasons" jsonb,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pkb_resolution_history_state_check" CHECK ("to_state" IN ('VERIFIED', 'HIGH_CONFIDENCE', 'AMBIGUOUS', 'UNRESOLVED')),
  CONSTRAINT "pkb_resolution_history_note_check" CHECK ("note" IS NULL OR length("note") <= 500)
);
--> statement-breakpoint
CREATE INDEX "pkb_resolution_history_product_idx" ON "pkb_resolution_history" ("pkb_product_id", "created_at");
--> statement-breakpoint
CREATE TRIGGER "pkb_resolution_history_append_only"
  BEFORE UPDATE OR DELETE ON "pkb_resolution_history"
  FOR EACH ROW EXECUTE FUNCTION pkb_append_only();
--> statement-breakpoint
-- "These two are different products": stops one being offered as the other's candidate.
CREATE TABLE "pkb_identity_distinctions" (
  "product_a_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "product_b_id" uuid NOT NULL REFERENCES "pkb_products"("id") ON DELETE CASCADE,
  "decided_by" uuid NOT NULL REFERENCES "users"("id"),
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("product_a_id", "product_b_id"),
  CONSTRAINT "pkb_identity_distinctions_order_check" CHECK ("product_a_id" < "product_b_id")
);
