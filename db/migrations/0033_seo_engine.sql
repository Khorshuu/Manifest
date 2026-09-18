-- Stage 4 of the knowledge platform: the SEO engine (D-077 to D-082).
--
-- Three things the database has to hold: which SEO fields a person decided
-- (so generated wording can never overwrite them), the addresses a listing
-- used to live at (so renaming one does not break its links), and the
-- measurable check results of a research run in place of the weighted scores
-- that read like a ranking (finding F13).

-- 1. Per-field SEO state ----------------------------------------------------
-- AUTO      nobody has decided; a generator may fill it.
-- SUGGESTED a generator proposed it and it is waiting for review.
-- MANUAL    a person wrote it; only a person changes it.
-- LOCKED    a person fixed it; nothing automatic may touch it at all.

CREATE TABLE "seo_field_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "field" text NOT NULL,
  "state" text NOT NULL DEFAULT 'AUTO',
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "source_run_id" uuid REFERENCES "seo_research_runs"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "seo_field_states_unique" UNIQUE ("product_id", "field"),
  CONSTRAINT "seo_field_states_field_check" CHECK ("field" IN (
    'seoFocusKeyword', 'seoMetaTitle', 'seoMetaDescription', 'canonicalUrl',
    'seoNoIndex', 'slug', 'title', 'descriptionHtml', 'bulletFeatures',
    'tags', 'searchKeywords', 'imageAlts'
  )),
  CONSTRAINT "seo_field_states_state_check" CHECK ("state" IN ('AUTO', 'SUGGESTED', 'MANUAL', 'LOCKED')),
  -- A decided state names who decided it and when. AUTO never does.
  CONSTRAINT "seo_field_states_decision_check" CHECK (
    ("state" IN ('MANUAL', 'LOCKED')) = ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  )
);

CREATE INDEX "seo_field_states_product_idx" ON "seo_field_states" ("product_id");

-- Every field change is already audited; this table keeps the before and after
-- of the SEO and content fields specifically, which the product audit entry
-- did not record (finding F9).
CREATE TABLE "seo_field_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "field" text NOT NULL,
  "before_value" text,
  "after_value" text,
  "before_state" text,
  "after_state" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "source_run_id" uuid REFERENCES "seo_research_runs"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "seo_field_history_product_idx" ON "seo_field_history" ("product_id", "created_at" DESC);

-- History is a record: it is written once and never edited.
CREATE FUNCTION seo_field_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'seo_field_history is append-only';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "seo_field_history_append_only"
BEFORE UPDATE OR DELETE ON "seo_field_history"
FOR EACH ROW EXECUTE FUNCTION seo_field_history_append_only();

-- 2. Addresses a listing used to have ---------------------------------------
-- A renamed listing keeps its old address working with a permanent redirect,
-- so links and search results already out in the world still arrive (F5).

CREATE TABLE "product_slug_redirects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_slug" text NOT NULL UNIQUE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "product_slug_redirects_product_idx" ON "product_slug_redirects" ("product_id");

-- 3. Research runs record counted checks, not a score ------------------------
-- The weighted 0-100 numbers read like a ranking the shop does not have. The
-- columns stay for the runs already stored; new runs write the counts.

ALTER TABLE "seo_research_runs"
  ADD COLUMN "seo_checks_passed" smallint,
  ADD COLUMN "seo_checks_total" smallint,
  ADD COLUMN "search_checks_passed" smallint,
  ADD COLUMN "search_checks_total" smallint;

COMMENT ON COLUMN "seo_research_runs"."seo_score" IS 'Legacy weighted score (finding F13). Not written by runs from Stage 4 on; read the check counts instead.';
COMMENT ON COLUMN "seo_research_runs"."search_score" IS 'Legacy weighted score (finding F13). Not written by runs from Stage 4 on; read the check counts instead.';

-- 4. Existing listings ------------------------------------------------------
-- A listing whose SEO fields somebody already wrote is treated as decided by a
-- person, because that is what happened: the fields were typed in the editor.
-- Nothing is invented; the state is derived from the value being present, and
-- no decider is claimed, so the state is SUGGESTED rather than MANUAL until a
-- person touches it again (D-077).
INSERT INTO "seo_field_states" ("product_id", "field", "state")
SELECT p.id, f.field, 'SUGGESTED'
FROM "products" p
CROSS JOIN LATERAL (
  VALUES
    ('seoFocusKeyword', p.seo_focus_keyword),
    ('seoMetaTitle', p.seo_meta_title),
    ('seoMetaDescription', p.seo_meta_description),
    ('canonicalUrl', p.canonical_url)
) AS f(field, value)
WHERE f.value IS NOT NULL AND btrim(f.value) <> ''
ON CONFLICT ("product_id", "field") DO NOTHING;
