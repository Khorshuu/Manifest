-- When a failed message may next be attempted (DECISIONS.md D-132).
--
-- A failed message used to be retried on every drain, one minute apart, and
-- parked for good after five attempts: an email provider that was down for
-- ten minutes lost every message queued in that time. With a real provider
-- behind the outbox the retries are spread out instead, each wait twice the
-- last, so an outage of a couple of hours heals by itself.
--
-- Nullable: a queued message, and every failed row from before this
-- migration, has no wait and is due at once, exactly as before.

ALTER TABLE "notifications" ADD COLUMN "next_attempt_at" timestamp with time zone;
