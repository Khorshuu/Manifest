-- Product preparation runs (docs/KNOWLEDGE_PLATFORM.md section 3H, DECISIONS.md D-112).
--
-- One durable row per attempt to take a product from "somebody typed a title"
-- to "its knowledge is settled, its content is generated and its page has been
-- checked". The row is the orchestration state: it names the work it started
-- rather than repeating it, so the enrichment run, the SEO Pulse run and the
-- resolution state all stay where they already live.
--
-- Why a table and not a job payload: enrichment is asynchronous and review is
-- a human step that may take days. The staff member closes the tab; the run
-- has to still be there when they come back, and a worker that restarts has to
-- be able to pick the same run up at the step it had reached. `steps` records
-- what has actually completed, which is what makes a retry idempotent — a
-- completed step is never done twice.
--
-- No offer data and no product facts are stored here. This table coordinates;
-- the knowledge base still decides.

CREATE TABLE "product_preparation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  -- Set once the listing has a knowledge product; null before the first sync.
  "pkb_product_id" uuid REFERENCES "pkb_products"("id") ON DELETE SET NULL,
  "stage" text NOT NULL DEFAULT 'IDENTIFYING',
  -- A second enqueue with the same key returns the same run (a double click).
  "request_key" text NOT NULL UNIQUE,
  "requested_by" uuid REFERENCES "users"("id"),
  "enrichment_run_id" uuid REFERENCES "pkb_enrichment_runs"("id") ON DELETE SET NULL,
  "seo_run_id" uuid REFERENCES "seo_research_runs"("id") ON DELETE SET NULL,
  -- [{ key, state, detail, at }] — the steps that have actually completed.
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ code, message, remedy }] — what a person has to decide, in their words.
  "review" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { code, message, remedy } — why it stopped. Never a stack trace.
  "failure" jsonb,
  -- [{ provider, status, message }] — the research provider's own report.
  "providers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many times the run has waited for asynchronous work, so a wait is
  -- bounded and each follow-up job has a key of its own.
  "ticks" integer NOT NULL DEFAULT 0,
  "cancel_requested" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  CONSTRAINT "product_preparation_stage_check" CHECK ("stage" IN (
    'IDENTIFYING', 'FINDING_SOURCES', 'RESEARCHING', 'VERIFYING', 'NEEDS_REVIEW',
    'PREPARING_CONTENT', 'PREPARING_SEARCH', 'CHECKING_PAGE',
    'READY', 'FAILED', 'BLOCKED', 'CANCELLED')),
  -- A finished run records when it finished; a live one does not.
  CONSTRAINT "product_preparation_finished_check" CHECK (
    ("stage" IN ('READY', 'FAILED', 'BLOCKED', 'CANCELLED')) = ("finished_at" IS NOT NULL))
);
--> statement-breakpoint

-- One live run per product: pressing the button twice continues the run that
-- exists rather than starting a second one against the same knowledge.
CREATE UNIQUE INDEX "product_preparation_one_live_idx"
  ON "product_preparation_runs" ("product_id")
  WHERE "finished_at" IS NULL;
--> statement-breakpoint

-- The status read: the newest run of one product.
CREATE INDEX "product_preparation_product_idx"
  ON "product_preparation_runs" ("product_id", "created_at" DESC);
--> statement-breakpoint

-- Deleting a knowledge product, an enrichment run or a research run sets these
-- to null, and a cascade with no index scans the table (D-106).
CREATE INDEX "product_preparation_pkb_product_idx"
  ON "product_preparation_runs" ("pkb_product_id") WHERE "pkb_product_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "product_preparation_enrichment_idx"
  ON "product_preparation_runs" ("enrichment_run_id") WHERE "enrichment_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "product_preparation_seo_run_idx"
  ON "product_preparation_runs" ("seo_run_id") WHERE "seo_run_id" IS NOT NULL;
