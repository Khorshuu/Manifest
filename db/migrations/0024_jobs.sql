-- Background jobs (DECISIONS.md D-053).
--
-- A job is claimed with FOR UPDATE SKIP LOCKED, so any number of workers can
-- drain the table without two of them taking the same row. A recurring job is
-- enqueued once per time slot under a dedupe key; the partial unique index is
-- what makes two triggers in the same minute schedule it once.
CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone,
  "locked_by" text,
  "last_error" text,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  CONSTRAINT "jobs_max_attempts_check" CHECK ("max_attempts" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_unique" ON "jobs" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" ("run_at") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" ("locked_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "jobs_kind_status_idx" ON "jobs" ("kind", "status");
--> statement-breakpoint
-- Notification delivery claims a row ('sending') before calling the provider,
-- so two concurrent drains cannot both send the same message.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_status_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_check"
  CHECK ("status" IN ('queued', 'sending', 'sent', 'failed'));
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "claimed_at" timestamp with time zone;
