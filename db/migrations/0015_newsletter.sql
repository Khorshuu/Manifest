-- Newsletter signups (MASTER_PRODUCT_SPEC.md section 5, "newsletter signup").
--
-- One row per address. Signing up twice is a no-op rather than an error, and
-- unsubscribing stamps `unsubscribed_at` instead of deleting the row, so a
-- later re-subscribe is a deliberate act that clears it again.
--
-- Nothing sends to this list yet: no email provider is connected (see
-- docs/PROGRESS.md). The table is the record of consent a provider will need.
--
-- Every statement is safe to run twice: `npm run db:setup` re-applies the
-- whole directory.

CREATE TABLE IF NOT EXISTS "newsletter_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id"),
  "source" text NOT NULL DEFAULT 'footer',
  "subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unsubscribed_at" timestamp with time zone,
  CONSTRAINT "newsletter_subscribers_email_unique" UNIQUE ("email")
);
