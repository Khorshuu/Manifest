-- When the job scheduler last called in (PRODUCTION-READINESS: scheduled jobs).
--
-- Background work must run from a real scheduler, never from site traffic
-- (D-059). A scheduler that silently stops — a cron removed, a secret rotated,
-- a plan downgraded — looks exactly like a quiet night, so each trigger records
-- itself here and staff can see how long ago it last ran.
CREATE TABLE "scheduler_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_report" jsonb NOT NULL DEFAULT '{}'::jsonb
);
