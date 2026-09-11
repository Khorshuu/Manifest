-- SKU reservations: the lifecycle of a product SKU (DECISIONS.md D-037).
--
--   reserved  — generated for an Add Product form that has not been saved yet.
--               Held for one admin until `expires_at`; nobody else can be given it.
--   finalized — the product was saved with this SKU. Permanent: the row is the
--               record that the SKU was used, so it is never generated again,
--               even if the product is archived or its SKU later edited.
--   released  — the form was abandoned or the hold expired. The SKU is free
--               again and may be generated for a later product.
--
-- The partial unique index is the database's own guarantee that no SKU is
-- ever reserved or permanent twice, whatever the application does.
--
-- Safe to run twice: `npm run db:setup` re-applies the whole directory.

CREATE TABLE IF NOT EXISTS "sku_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sku" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "reserved_by" uuid NOT NULL REFERENCES "users"("id"),
  "product_id" uuid REFERENCES "products"("id"),
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "finalized_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  CONSTRAINT "sku_reservations_status_check" CHECK ("status" in ('reserved', 'finalized', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sku_reservations_held_sku_unique"
  ON "sku_reservations" ("sku") WHERE "status" in ('reserved', 'finalized');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sku_reservations_expiry_idx"
  ON "sku_reservations" ("expires_at") WHERE "status" = 'reserved';
