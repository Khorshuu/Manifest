-- Order numbers were allocated as `count(*) + 1` over the orders already
-- placed this year, against a UNIQUE column. Two checkouts in the same instant
-- read the same count, both tried to insert the same number, and one customer
-- got "Something went wrong" at the moment they pressed Place order.
--
-- A sequence is the fix that costs nothing. `nextval` is atomic, takes no
-- transaction-scoped lock, and two concurrent callers are simply handed
-- different values.
--
-- The first attempt at this used a counter row incremented with an upsert.
-- That is also correct, but the upsert holds a row lock for the rest of the
-- transaction, so every checkout queued behind every other one — the
-- end-to-end suite went from 9 minutes to 12.7 and ten tests timed out. The
-- table is dropped here because it never shipped.
DROP TABLE IF EXISTS "order_number_counters";
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "order_number_seq" AS bigint START WITH 1;
--> statement-breakpoint
-- Continue past anything already issued, so no number can be handed out twice.
-- `is_called = false` means the value set here is the next one returned, which
-- gives 1 on a database with no orders rather than skipping it.
SELECT setval(
  'order_number_seq',
  COALESCE(
    (
      SELECT MAX(CAST(split_part("order_number", '-', 3) AS bigint))
      FROM "orders"
      WHERE "order_number" ~ '^ORD-[0-9]{4}-[0-9]+$'
    ),
    0
  ) + 1,
  false
);
