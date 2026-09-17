-- Audit log paging (PRODUCTION-READINESS 14.1).
--
-- Every entry written in one transaction shares its created_at, so the log is
-- ordered by (created_at, id) and paged by keyset on that pair. The first index
-- serves the unfiltered log and replaces the created_at-only one; the second
-- serves the log filtered by action and lets the list of distinct actions be
-- read by skipping along it instead of grouping every row.
CREATE INDEX "audit_log_created_at_id_idx" ON "audit_log" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "audit_log_action_created_at_id_idx" ON "audit_log" ("action", "created_at" DESC, "id" DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_created_at_idx";
