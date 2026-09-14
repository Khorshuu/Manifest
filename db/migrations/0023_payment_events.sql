-- Every event a payment provider sends, recorded before it is acted on.
--
-- The unique (provider, event_id) pair is what makes a webhook idempotent: a
-- provider that retries, or sends the same event twice at once, finds the row
-- already there and changes nothing. The status says how far processing got,
-- so a failure is visible and the next delivery of the same event can retry
-- it rather than being ignored as a duplicate.
CREATE TABLE "payment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_ref" text,
  "amount_bdt" integer,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "error" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "payment_events_status_check"
    CHECK ("status" IN ('received', 'processing', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique"
  ON "payment_events" ("provider", "event_id");
--> statement-breakpoint
CREATE INDEX "payment_events_provider_ref_idx" ON "payment_events" ("provider_ref");
--> statement-breakpoint
CREATE INDEX "payment_events_unfinished_idx" ON "payment_events" ("received_at")
  WHERE "status" IN ('received', 'processing', 'failed');
