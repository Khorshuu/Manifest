-- When a listing first became visible to shoppers (D-078).
--
-- The address of a listing nobody has seen may still follow its title; the
-- address of one that has been public may not, because links and search
-- results already point at it. Until now there was nothing to tell the two
-- apart: `publish_at` is a schedule, and `status` can go back to draft.

ALTER TABLE "products" ADD COLUMN "first_published_at" timestamptz;

-- Anything public now, or scheduled, or already ordered from, has been seen.
UPDATE "products" SET "first_published_at" = COALESCE("publish_at", "created_at")
WHERE "status" IN ('scheduled', 'in_stock', 'preorder_open', 'preorder_closed', 'coming_soon', 'discontinued')
   OR "archived_at" IS NOT NULL;
