-- Refunds were recorded as negative payment rows with nothing tying them to the
-- charge they reversed. That is enough to know what an order is owed in total,
-- and not enough to know how much of any one charge is still refundable — so a
-- partial refund had no safe way to pick which charge to refund against, and
-- repeated partial refunds could between them exceed what was captured.
--
-- The link makes per-charge accounting possible: a charge's remaining amount is
-- itself, less the refunds that point at it.
ALTER TABLE "payments"
  ADD COLUMN "refunded_payment_id" uuid REFERENCES "payments"("id");
--> statement-breakpoint
CREATE INDEX "payments_refunded_payment_id_idx"
  ON "payments" ("refunded_payment_id");
--> statement-breakpoint
-- Existing refunds predate the link. Each is attached to the largest charge on
-- its own order, which is where a full refund would have taken it from — the
-- amounts already net out correctly, so this only records which charge they
-- came from.
UPDATE "payments" AS "refund"
SET "refunded_payment_id" = (
  SELECT "charge"."id"
  FROM "payments" AS "charge"
  WHERE "charge"."order_id" = "refund"."order_id"
    AND "charge"."kind" <> 'refund'
  ORDER BY "charge"."amount_bdt" DESC, "charge"."created_at"
  LIMIT 1
)
WHERE "refund"."kind" = 'refund'
  AND "refund"."refunded_payment_id" IS NULL;
--> statement-breakpoint
-- A refund with no charge to point at cannot exist and never could: it would be
-- money returned against nothing. Any such row is corrupt, and deleting it here
-- would hide that, so the constraint below is left to refuse it loudly.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_links_a_charge_check"
  CHECK (
    ("kind" = 'refund' AND "refunded_payment_id" IS NOT NULL)
    OR ("kind" <> 'refund' AND "refunded_payment_id" IS NULL)
  );
