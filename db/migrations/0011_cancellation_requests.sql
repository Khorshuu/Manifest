-- A shopper asking to cancel used to cancel the order outright. It now records
-- a request instead: staff review it, talk to the customer, and make the final
-- decision from the admin side.
--
-- That changes when capacity comes back. It used to be returned the moment the
-- shopper pressed the button; it is now returned when staff approve, because
-- until then nothing has been decided and the place is still theirs.
ALTER TABLE "orders"
  ADD COLUMN "cancellation_requested_at" timestamptz;
--> statement-breakpoint
-- The customer's own words. Kept separate from `internal_notes`, which is staff
-- wording and never reaches a shopper.
ALTER TABLE "orders"
  ADD COLUMN "cancellation_reason" text;
--> statement-breakpoint
-- The admin queue reads exactly this: open requests, oldest first.
CREATE INDEX "orders_cancellation_requested_at_idx"
  ON "orders" ("cancellation_requested_at")
  WHERE "cancellation_requested_at" IS NOT NULL;
