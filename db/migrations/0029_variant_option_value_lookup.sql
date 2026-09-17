-- Looking up variants by option value (PRODUCTION-READINESS 14.1).
--
-- The product editor counts, for every value of every option, how many live
-- and archived variants carry it; removing a value checks the same. With only
-- the (variant_id, attribute_id) key each count scanned the whole table, so a
-- product with 250 values took about 280 ms on the scale dataset. With this
-- index the same page's counts take about 2 ms.
CREATE INDEX "variant_option_values_attribute_value_id_idx" ON "variant_option_values" ("attribute_value_id");
