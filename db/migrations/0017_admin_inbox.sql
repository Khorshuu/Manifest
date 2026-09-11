-- The admin inbox: what each staff member has already read.
--
-- The inbox itself is not a table. Every item in it — a new order, a failed
-- message, a batch running out — is read live from the rows that already
-- record it, so it can never disagree with them. The only new fact is where
-- each person got up to, which is one timestamp per account (DECISIONS.md
-- D-036).
--
-- Safe to run twice: `npm run db:setup` re-applies the whole directory.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_inbox_seen_at" timestamp with time zone;
