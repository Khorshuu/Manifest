-- Stage 6 of the knowledge platform: Google Search Console, the opportunity
-- engine and SEO change history (D-096 to D-100).
--
-- Three things the database has to hold:
--
--  1. What Google reports about this site's pages, day by day, kept apart from
--     everything the Product Knowledge Base treats as a fact about a product.
--     It is measured external analytics: internal only, never exportable, and
--     never a source of product truth (invariants I-1, I-9, I-10).
--  2. Enough synchronisation state that a retried or overlapping sync cannot
--     store a day twice, and that a failure says what went wrong.
--  3. One SEO change history covering listings *and* shelves, so a before and
--     after comparison has something to anchor to.

-- 1. SEO change history -----------------------------------------------------
-- Section 4.4 of the platform tracker planned a `seo_change_history` table.
-- Stage 4 had already built `seo_field_history` for listings, with the exact
-- columns that plan wanted; a second table holding the same kind of row would
-- be the "two stores, one fact" mistake this programme keeps closing. So the
-- Stage 4 table becomes the one change history, widened to cover any SEO
-- entity and to record which workflow made the change.

ALTER TABLE "seo_field_history"
  ADD COLUMN "entity_type" text NOT NULL DEFAULT 'product',
  ADD COLUMN "category_id" uuid REFERENCES "categories"("id") ON DELETE CASCADE,
  ADD COLUMN "workflow" text NOT NULL DEFAULT 'editor';

-- A shelf has no per-field state machine behind it (that is a listing thing),
-- so its rows record no state rather than claiming one that is not stored.
ALTER TABLE "seo_field_history" ALTER COLUMN "after_state" DROP NOT NULL;
ALTER TABLE "seo_field_history" ALTER COLUMN "product_id" DROP NOT NULL;

ALTER TABLE "seo_field_history"
  ADD CONSTRAINT "seo_field_history_entity_check" CHECK (
    ("entity_type" = 'product' AND "product_id" IS NOT NULL AND "category_id" IS NULL)
    OR ("entity_type" = 'category' AND "category_id" IS NOT NULL AND "product_id" IS NULL)
  ),
  ADD CONSTRAINT "seo_field_history_workflow_check" CHECK ("workflow" IN (
    'editor', 'seo_pulse_apply', 'seo_pulse_fill', 'lock', 'import', 'system'
  ));

CREATE INDEX "seo_field_history_category_idx" ON "seo_field_history" ("category_id", "created_at" DESC);
CREATE INDEX "seo_field_history_changed_idx" ON "seo_field_history" ("created_at" DESC);

COMMENT ON TABLE "seo_field_history" IS
  'The SEO change history (D-098): one append-only row per change to a listing or shelf SEO field, with before, after, actor, reason and the workflow that made it.';

-- 2. Search Console synchronisation state -----------------------------------
-- One row per property. The watermark says how far the stored measurements are
-- known to reach; a sync always re-reads a trailing window on top of it,
-- because Search Console finalises the last few days after first reporting
-- them. Re-reading is safe precisely because storage is an upsert on the
-- natural key below.

CREATE TABLE "search_console_sync_state" (
  "property" text PRIMARY KEY,
  "provider_key" text NOT NULL,
  "last_attempt_at" timestamptz,
  "last_success_at" timestamptz,
  "last_status" text NOT NULL DEFAULT 'never_run',
  "last_error" text,
  -- Every day up to and including this one has been fetched at least once.
  "synced_through" date,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "search_console_sync_state_status_check" CHECK ("last_status" IN (
    'never_run', 'ok', 'not_configured', 'unavailable', 'failed'
  ))
);

-- One row per attempt: what was asked for, what came back, and why it failed.
CREATE TABLE "search_console_syncs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "property" text NOT NULL,
  -- The same key is refused a second row, so a double click, a retried request
  -- and an overlapping scheduled run are one sync.
  "request_key" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'queued',
  "trigger" text NOT NULL,
  "requested_by" uuid REFERENCES "users"("id"),
  "window_start" date NOT NULL,
  "window_end" date NOT NULL,
  "provider_key" text NOT NULL,
  "provider_state" text,
  -- How many provider requests this sync made (pagination and dimensions).
  "requests_made" integer NOT NULL DEFAULT 0,
  "rows_fetched" integer NOT NULL DEFAULT 0,
  "rows_written" integer NOT NULL DEFAULT 0,
  "rows_unchanged" integer NOT NULL DEFAULT 0,
  "days_covered" integer NOT NULL DEFAULT 0,
  "message" text,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "search_console_syncs_status_check" CHECK ("status" IN (
    'queued', 'running', 'completed', 'failed', 'skipped'
  )),
  CONSTRAINT "search_console_syncs_trigger_check" CHECK ("trigger" IN ('manual', 'scheduled')),
  CONSTRAINT "search_console_syncs_state_check" CHECK (
    "provider_state" IS NULL OR "provider_state" IN ('OK', 'NOT_CONFIGURED', 'UNAVAILABLE', 'FAILED')
  ),
  CONSTRAINT "search_console_syncs_window_check" CHECK ("window_start" <= "window_end")
);

CREATE INDEX "search_console_syncs_property_idx" ON "search_console_syncs" ("property", "created_at" DESC);

-- 3. The measurements -------------------------------------------------------
-- Exactly what Search Console reported, per day, for one of three dimension
-- shapes. Nothing here is computed, estimated or filled in: a day that was
-- never fetched has no row, and an absent row means "not measured", never
-- zero.
--
-- The natural key is (property, day, dimension, page, query). `page_path` and
-- `query` are NOT NULL with an empty string meaning "this dimension does not
-- use it", because a unique index over nullable columns would let the same
-- measurement be stored twice.

CREATE TABLE "search_console_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "property" text NOT NULL,
  "measured_on" date NOT NULL,
  "dimension" text NOT NULL,
  "page_path" text NOT NULL DEFAULT '',
  "query" text NOT NULL DEFAULT '',
  -- The comparison form of the query, so a Search Console phrase and an
  -- internal search can be compared without a second normalisation rule
  -- (the twin of `search_term_key`, computed by lib/search/terms.ts).
  "query_key" text NOT NULL DEFAULT '',
  -- Which page of this shop the address resolves to, when it resolves at all.
  -- Nullable on purpose: Search Console also reports pages this shop no longer
  -- has, and dropping those rows would hide a real problem.
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "category_id" uuid REFERENCES "categories"("id") ON DELETE SET NULL,
  "clicks" integer NOT NULL,
  "impressions" integer NOT NULL,
  -- Derived, never stored independently, so it cannot disagree with the two
  -- counts it comes from.
  "ctr" numeric(9, 8) GENERATED ALWAYS AS (
    CASE WHEN "impressions" > 0 THEN round("clicks"::numeric / "impressions", 8) ELSE 0 END
  ) STORED,
  -- An impression-weighted average Google computes; it cannot be recomputed
  -- from anything stored here, so it is kept as reported.
  "position" numeric(6, 2) NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_sync_id" uuid REFERENCES "search_console_syncs"("id") ON DELETE SET NULL,
  CONSTRAINT "search_console_metrics_unique" UNIQUE ("property", "measured_on", "dimension", "page_path", "query"),
  CONSTRAINT "search_console_metrics_dimension_check" CHECK ("dimension" IN ('page', 'query', 'page_query')),
  -- Each dimension says which of the two keys it actually carries.
  CONSTRAINT "search_console_metrics_shape_check" CHECK (
    ("dimension" = 'page' AND "page_path" <> '' AND "query" = '')
    OR ("dimension" = 'query' AND "page_path" = '' AND "query" <> '')
    OR ("dimension" = 'page_query' AND "page_path" <> '' AND "query" <> '')
  ),
  CONSTRAINT "search_console_metrics_counts_check" CHECK (
    "clicks" >= 0 AND "impressions" >= 0 AND "clicks" <= "impressions" AND "position" >= 0
  ),
  CONSTRAINT "search_console_metrics_length_check" CHECK (
    length("page_path") <= 1000 AND length("query") <= 300
  )
);

CREATE INDEX "search_console_metrics_window_idx"
  ON "search_console_metrics" ("property", "dimension", "measured_on" DESC);
CREATE INDEX "search_console_metrics_product_idx"
  ON "search_console_metrics" ("product_id", "measured_on" DESC)
  WHERE "product_id" IS NOT NULL;
CREATE INDEX "search_console_metrics_category_idx"
  ON "search_console_metrics" ("category_id", "measured_on" DESC)
  WHERE "category_id" IS NOT NULL;
CREATE INDEX "search_console_metrics_query_idx"
  ON "search_console_metrics" ("property", "query_key", "measured_on" DESC)
  WHERE "query_key" <> '';
CREATE INDEX "search_console_metrics_page_idx"
  ON "search_console_metrics" ("property", "page_path", "measured_on" DESC)
  WHERE "page_path" <> '';

COMMENT ON TABLE "search_console_metrics" IS
  'Google Search Console measurements (D-096). Internal analytics: PROVIDER_RESTRICTED, never exportable (I-10), never a source of Product Knowledge Base facts (I-1), and it holds no customer identifier (I-9).';

-- 4. What staff decided about an opportunity --------------------------------
-- Opportunities themselves are computed from the measurements on every read,
-- like the readiness checks and the zero-result verdicts before them: storing
-- a derived list means keeping it in step with the data it came from, and a
-- stale row would report an opportunity that no longer exists. What *is*
-- stored is the decision a person made about one, which is a fact about the
-- shop's work and cannot be recomputed.

CREATE TABLE "seo_opportunity_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identifies the opportunity across recomputations: kind + entity + subject.
  "opportunity_key" text NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "entity_type" text NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE,
  "category_id" uuid REFERENCES "categories"("id") ON DELETE CASCADE,
  "decision" text NOT NULL,
  "note" text,
  -- The measurements as they stood when the decision was made, so a later
  -- reader can see what was known then.
  "evidence" jsonb,
  "decided_by" uuid NOT NULL REFERENCES "users"("id"),
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "seo_opportunity_decisions_decision_check" CHECK ("decision" IN ('acted', 'dismissed', 'watching')),
  CONSTRAINT "seo_opportunity_decisions_entity_check" CHECK ("entity_type" IN ('product', 'category', 'site'))
);

CREATE INDEX "seo_opportunity_decisions_product_idx" ON "seo_opportunity_decisions" ("product_id");
CREATE INDEX "seo_opportunity_decisions_kind_idx" ON "seo_opportunity_decisions" ("kind", "decided_at" DESC);
