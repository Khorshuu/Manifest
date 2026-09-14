-- Ordering indexes for the admin order list and keyset paging.
--
-- Measured on 100,000 orders (docs/PRODUCTION-READINESS.md, Phase 8):
--   newest first, page 1        202 ms  ->  0.44 ms (with the lateral line summary)
--   newest first, 1,000 pages in 42 ms  ->  0.02 ms (keyset on placed_at, id)
--   one status, deep page        12 ms  ->  1.5 ms
--
-- The id is in both indexes because it is the tie-breaker the keyset cursor
-- compares on: orders placed in the same instant still page in a stable order.
CREATE INDEX "orders_placed_at_id_idx" ON "orders" ("placed_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "orders_status_placed_at_id_idx" ON "orders" ("status", "placed_at" DESC, "id" DESC);
--> statement-breakpoint
-- Its leading column makes the composite serve every "status = …" lookup this
-- index served, so keeping both only adds a write to every checkout.
DROP INDEX "orders_status_idx";
