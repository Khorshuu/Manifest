-- SEO Pulse (DECISIONS.md D-038).
--
-- seo_research_runs: one row per research run, versioned per product. A new
-- run never replaces an old one; regenerating inserts the next version.
--
-- products.seo_focus_keyword: the one search phrase a listing is written to
-- rank for. It had nowhere to live before, and SEO Pulse both recommends it and
-- scores the listing against it. It is never shown to a shopper.
--
-- Safe to run twice: `npm run db:setup` re-applies the whole directory.

CREATE TABLE IF NOT EXISTS "seo_research_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id"),
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "request_key" text NOT NULL,
  "initiated_by" uuid REFERENCES "users"("id"),
  "input_snapshot" jsonb NOT NULL,
  "input_hash" text NOT NULL,
  "research" jsonb,
  "analysis" jsonb,
  "seo_score" smallint,
  "search_score" smallint,
  "provider_usage" jsonb,
  "pulse_version" text NOT NULL,
  "error" text,
  "applied_fields" jsonb,
  "applied_at" timestamp with time zone,
  "applied_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "seo_research_runs_status_check" CHECK ("status" in ('running', 'completed', 'failed')),
  CONSTRAINT "seo_research_runs_version_unique" UNIQUE ("product_id", "version"),
  CONSTRAINT "seo_research_runs_request_key_unique" UNIQUE ("request_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_research_runs_product_idx"
  ON "seo_research_runs" ("product_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_research_runs_created_idx"
  ON "seo_research_runs" ("created_at");
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_focus_keyword" text;
