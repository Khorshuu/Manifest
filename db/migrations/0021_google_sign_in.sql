-- Signing in with Google (DECISIONS.md D-041).
--
-- An account reached through Google has no password of its own, so the hash
-- becomes optional. Every existing row keeps the hash it has, and the sign-in
-- path still refuses an account with no password rather than treating a null
-- hash as "no password needed".
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint

-- One row per external identity linked to an account. The provider's own
-- subject identifier is what is matched on, never the email address alone:
-- an email can be reassigned by its domain owner, a subject cannot.
CREATE TABLE IF NOT EXISTS "oauth_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_accounts_provider_check" CHECK ("provider" in ('google'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_accounts_provider_subject_unique"
  ON "oauth_accounts" ("provider", "provider_account_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oauth_accounts_user_idx" ON "oauth_accounts" ("user_id");
