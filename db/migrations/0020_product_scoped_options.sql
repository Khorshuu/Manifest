-- Variant options belong to the product they describe (DECISIONS.md D-040).
--
-- Until now "Color" was one shop-wide option whose values every product saw:
-- a new sofa listed another sofa's colours, and removing a value warned about
-- products that had nothing to do with it. Each option now carries the
-- product it belongs to. Storefront filters and search group options by
-- name, so two products' "Color" options still filter together.
--
-- scope_product_attributes() converts any shared option a product uses into a
-- copy owned by that product, carrying only the values its variants use, and
-- repoints the variants. It is run here for existing data and by the seed.
-- Safe to run twice: `npm run db:setup` re-applies the whole directory.

ALTER TABLE "attributes" ADD COLUMN IF NOT EXISTS "product_id" uuid REFERENCES "products"("id");
--> statement-breakpoint
ALTER TABLE "attributes" DROP CONSTRAINT IF EXISTS "attributes_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attributes_shared_name_unique"
  ON "attributes" ("name") WHERE "product_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attributes_product_name_unique"
  ON "attributes" ("product_id", lower("name")) WHERE "product_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attributes_product_id_idx" ON "attributes" ("product_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scope_product_attributes() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  pair record;
  val record;
  new_attr uuid;
  new_val uuid;
  converted integer := 0;
BEGIN
  FOR pair IN
    SELECT DISTINCT v.product_id, vov.attribute_id
      FROM variant_option_values vov
      JOIN product_variants v ON v.id = vov.variant_id
      JOIN attributes a ON a.id = vov.attribute_id
     WHERE a.product_id IS NULL
    UNION
    SELECT pa.product_id, pa.attribute_id
      FROM product_attributes pa
      JOIN attributes a ON a.id = pa.attribute_id
     WHERE a.product_id IS NULL
  LOOP
    INSERT INTO attributes (name, input_type, product_id)
      SELECT a.name, a.input_type, pair.product_id FROM attributes a WHERE a.id = pair.attribute_id
      RETURNING id INTO new_attr;

    FOR val IN
      SELECT DISTINCT av.id, av.value, av.sort_order
        FROM variant_option_values vov
        JOIN product_variants v ON v.id = vov.variant_id
        JOIN attribute_values av ON av.id = vov.attribute_value_id
       WHERE v.product_id = pair.product_id AND vov.attribute_id = pair.attribute_id
    LOOP
      INSERT INTO attribute_values (attribute_id, value, sort_order)
        VALUES (new_attr, val.value, val.sort_order)
        RETURNING id INTO new_val;
      UPDATE variant_option_values
         SET attribute_id = new_attr, attribute_value_id = new_val
       WHERE attribute_value_id = val.id
         AND variant_id IN (SELECT id FROM product_variants WHERE product_id = pair.product_id);
    END LOOP;

    UPDATE product_attributes
       SET attribute_id = new_attr
     WHERE product_id = pair.product_id AND attribute_id = pair.attribute_id;

    converted := converted + 1;
  END LOOP;
  RETURN converted;
END $$;
--> statement-breakpoint
SELECT scope_product_attributes();
