-- A setting is keyed by name, not by uuid, so the audit log cannot assume one.
ALTER TABLE "audit_log" ALTER COLUMN "entity_id" TYPE text USING "entity_id"::text;
