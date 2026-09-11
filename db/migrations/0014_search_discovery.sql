-- Search and product discovery (DECISIONS.md D-026 to D-030).
--
-- Search used to be one expression index over the product row. It could not
-- see anything that lives in another table — the category's name, the
-- variants' option values, the specifications a category defines — so those
-- were matched with unindexed subqueries, and it had no idea of a typo.
--
-- What replaces it:
--
--  * `product_search`, one row per product: a weighted full-text document
--    (A = the name, B = brand, model, codes, keywords and the shelf,
--    C = highlights, options and specifications, D = everything else a
--    shopper reads), plus the normalised name and codes the ranking compares
--    against.
--  * `product_search_words`, the vocabulary of each listing, which is what a
--    misspelling is corrected against (pg_trgm similarity, index-backed).
--  * Triggers on every table the document is built from. They queue the
--    product, and a deferred trigger rebuilds its row once, at commit, from
--    the final state of the transaction. Nothing in the application has to
--    remember to reindex, and a checkout never pays for it: the capacity
--    columns a reservation touches are not ones the document reads.
--
-- Visibility is deliberately not in the index. Whether a product may be shown
-- is decided live, by joining `products` with the public predicate, so a stale
-- index row can at worst match on old words — it can never show a draft.
--
-- Every statement is safe to run twice: `npm run db:setup` re-applies the
-- whole directory.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Merchandising controls on a listing ----------------------------------------
-- Hidden from search is not unpublished: the product page, the category
-- listing and the cart all keep working. It only stops the search box finding
-- it.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "searchable" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- A bounded nudge. The ranking uses it only to reorder products that are
-- already equally relevant, so it cannot lift a weak match over a strong one.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_boost" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_search_boost_check"
    CHECK ("search_boost" BETWEEN -2 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Which specifications become filters, and which are searched ----------------
-- Free text, links and dates make poor filters (every value is different), so
-- existing definitions of those kinds start switched off. Done only the first
-- time, so a later re-run does not undo a choice staff have made since.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'category_attributes'
      AND column_name = 'is_filterable'
  ) THEN
    ALTER TABLE "category_attributes"
      ADD COLUMN "is_filterable" boolean NOT NULL DEFAULT true;
    UPDATE "category_attributes" SET "is_filterable" = false
      WHERE "data_type" IN ('text', 'url', 'date');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "category_attributes" ADD COLUMN IF NOT EXISTS "is_searchable" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- Normalisation, defined once -------------------------------------------------
-- The ranking compares a normalised query against normalised names, so both
-- sides go through these same functions rather than two implementations that
-- could drift.
CREATE OR REPLACE FUNCTION search_normalize(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT btrim(regexp_replace(lower(coalesce(value, '')), '[^[:alnum:]]+', ' ', 'g')) $$;
--> statement-breakpoint
-- A code with its punctuation removed: "ABC-123", "abc 123" and "ABC123" are
-- the same SKU to someone typing it.
CREATE OR REPLACE FUNCTION search_code(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT regexp_replace(lower(coalesce(value, '')), '[^[:alnum:]]+', '', 'g') $$;
--> statement-breakpoint
-- The URL key of a filterable attribute: "Screen size" is `screen-size`.
CREATE OR REPLACE FUNCTION search_slug(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT btrim(regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '-', 'g'), '-') $$;
--> statement-breakpoint
-- A JSON string array as words.
CREATE OR REPLACE FUNCTION search_json_text(value jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT coalesce(string_agg(x, ' '), '')
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
    ) AS x
  $$;
--> statement-breakpoint
-- The hand-typed specification table, label and value both.
CREATE OR REPLACE FUNCTION search_spec_text(value jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT coalesce(string_agg(
      coalesce(x ->> 'label', '') || ' ' || coalesce(x ->> 'value', ''), ' '
    ), '')
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
    ) AS x
    WHERE jsonb_typeof(x) = 'object'
  $$;
--> statement-breakpoint
-- Hyphenated words joined up, so "wifi" finds "Wi-Fi" and "usbc" finds "USB-C".
CREATE OR REPLACE FUNCTION search_joined(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT coalesce(string_agg(replace(m[1], '-', ''), ' '), '')
    FROM regexp_matches(coalesce(value, ''), '([[:alnum:]]+(?:-[[:alnum:]]+)+)', 'g') AS m
  $$;
--> statement-breakpoint

-- The index -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "product_search" (
  "product_id" uuid PRIMARY KEY REFERENCES "products"("id") ON DELETE CASCADE,
  "document" tsvector NOT NULL,
  -- The whole name, normalised.
  "title_norm" text NOT NULL,
  -- The name up to its first comma, bracket or dash: "Apple iPhone 15" out of
  -- "Apple iPhone 15, 128 GB (Blue)". What the product *is*.
  "title_core" text NOT NULL,
  "title_words" smallint NOT NULL,
  "brand_norm" text NOT NULL DEFAULT '',
  -- The category and every shelf above it.
  "category_norm" text NOT NULL DEFAULT '',
  -- SKUs, trade identifiers, model and part numbers, with punctuation removed.
  "codes" text[] NOT NULL DEFAULT '{}',
  -- The four weighted texts the document was built from, kept so the
  -- vocabulary can be rebuilt from them and so staff can see what is indexed.
  "text_a" text NOT NULL DEFAULT '',
  "text_b" text NOT NULL DEFAULT '',
  "text_c" text NOT NULL DEFAULT '',
  "text_d" text NOT NULL DEFAULT '',
  "indexed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_document_idx"
  ON "product_search" USING GIN ("document");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_codes_idx"
  ON "product_search" USING GIN ("codes");
--> statement-breakpoint
-- A search inside a word — "board" in "Keyboard" — which a stemmed prefix
-- query cannot find.
CREATE INDEX IF NOT EXISTS "product_search_title_trgm_idx"
  ON "product_search" USING GIN ("title_norm" gin_trgm_ops);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "product_search_words" (
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "word" text NOT NULL,
  -- The word as the listing spells it, so a correction reads "iPhone".
  "display" text NOT NULL,
  -- 4 the name, 3 brand, codes, keywords and shelf, 2 highlights and
  -- specifications, 1 the description.
  "weight" smallint NOT NULL,
  PRIMARY KEY ("product_id", "word")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_words_trgm_idx"
  ON "product_search_words" USING GIN ("word" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_words_prefix_idx"
  ON "product_search_words" ("word" text_pattern_ops);
--> statement-breakpoint

-- Products waiting to be reindexed. A row lives for the length of one
-- transaction, unless its rebuild failed — then it stays for the scheduled
-- sweep to retry, and staff can see it on the search admin page.
CREATE TABLE IF NOT EXISTS "product_search_queue" (
  "product_id" uuid PRIMARY KEY REFERENCES "products"("id") ON DELETE CASCADE,
  "queued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint

-- Builds the index rows for a set of products from the tables they live in.
CREATE OR REPLACE FUNCTION refresh_product_search(ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN
    RETURN;
  END IF;

  WITH RECURSIVE
  targets AS (
    SELECT p.* FROM products p WHERE p.id = ANY(ids)
  ),
  lineage AS (
    SELECT t.id AS product_id, c.parent_id, c.name, 0 AS depth
    FROM targets t
    JOIN categories c ON c.id = t.category_id
    UNION ALL
    SELECT l.product_id, c.parent_id, c.name, l.depth + 1
    FROM lineage l
    JOIN categories c ON c.id = l.parent_id
    WHERE l.depth < 16
  ),
  shelf AS (
    SELECT product_id, string_agg(name, ' ' ORDER BY depth DESC) AS names
    FROM lineage
    GROUP BY product_id
  ),
  -- What a shopper can choose between: only live variants count.
  options AS (
    SELECT v.product_id, string_agg(DISTINCT av.value, ' ') AS option_values
    FROM product_variants v
    JOIN variant_option_values vov ON vov.variant_id = v.id
    JOIN attribute_values av ON av.id = vov.attribute_value_id
    WHERE v.product_id = ANY(ids) AND v.is_enabled AND v.archived_at IS NULL
    GROUP BY v.product_id
  ),
  skus AS (
    SELECT v.product_id,
           array_agg(DISTINCT v.sku) AS list,
           string_agg(DISTINCT v.sku, ' ') AS words
    FROM product_variants v
    WHERE v.product_id = ANY(ids) AND v.archived_at IS NULL
    GROUP BY v.product_id
  ),
  -- Category-defined specifications, named, so "16 GB RAM" is vocabulary. A
  -- yes/no one is indexed by its name when the answer is yes: "5G", not "true".
  specs AS (
    SELECT t.id AS product_id,
      string_agg(
        CASE
          WHEN d.data_type = 'boolean' THEN
            CASE WHEN e.value #>> '{}' = 'true' THEN d.name END
          ELSE d.name || ' ' ||
            CASE jsonb_typeof(e.value)
              WHEN 'array' THEN search_json_text(e.value)
              ELSE coalesce(e.value #>> '{}', '')
            END || coalesce(' ' || d.unit, '')
        END, ' ') AS words
    FROM targets t
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(t.attribute_values) = 'object'
        THEN t.attribute_values ELSE '{}'::jsonb END
    ) AS e(key, value)
    JOIN category_attributes d ON d.id::text = e.key AND d.is_searchable
    GROUP BY t.id
  ),
  fields AS (
    SELECT
      t.id AS product_id,
      t.title,
      coalesce(t.brand, '') AS brand,
      t.title AS text_a,
      concat_ws(' ',
        t.brand,
        t.details ->> 'manufacturer',
        t.details ->> 'modelName',
        t.details ->> 'modelNumber',
        t.details ->> 'manufacturerPartNumber',
        t.sku,
        t.identifier_value,
        s.words,
        search_json_text(t.search_keywords),
        sh.names
      ) AS text_b,
      concat_ws(' ',
        search_json_text(t.bullet_features),
        o.option_values,
        sp.words,
        t.details ->> 'material',
        t.details ->> 'color',
        t.details ->> 'size',
        t.details ->> 'compatibility',
        t.details ->> 'specialFeatures',
        t.details ->> 'intendedUse'
      ) AS text_c,
      concat_ws(' ',
        regexp_replace(
          regexp_replace(coalesce(t.description_html, ''), '<[^>]*>', ' ', 'g'),
          '&[#[:alnum:]]+;', ' ', 'g'
        ),
        search_spec_text(t.spec_table),
        search_json_text(t.box_contents),
        search_json_text(t.tags),
        t.seo_meta_description
      ) AS text_d,
      coalesce(sh.names, '') AS shelf_names,
      ARRAY[
        t.sku,
        t.identifier_value,
        t.details ->> 'modelNumber',
        t.details ->> 'manufacturerPartNumber'
      ] || coalesce(s.list, '{}'::text[]) AS raw_codes
    FROM targets t
    LEFT JOIN shelf sh ON sh.product_id = t.id
    LEFT JOIN options o ON o.product_id = t.id
    LEFT JOIN skus s ON s.product_id = t.id
    LEFT JOIN specs sp ON sp.product_id = t.id
  )
  INSERT INTO product_search AS ps (
    product_id, document, title_norm, title_core, title_words, brand_norm,
    category_norm, codes, text_a, text_b, text_c, text_d, indexed_at
  )
  SELECT
    f.product_id,
    setweight(to_tsvector('english', f.text_a || ' ' || search_joined(f.text_a)), 'A')
      || setweight(to_tsvector('english', f.text_b || ' ' || search_joined(f.text_b)), 'B')
      || setweight(to_tsvector('english', f.text_c || ' ' || search_joined(f.text_c)), 'C')
      || setweight(to_tsvector('english', f.text_d), 'D'),
    search_normalize(f.title),
    core.value,
    coalesce(array_length(string_to_array(nullif(core.value, ''), ' '), 1), 0),
    search_normalize(f.brand),
    search_normalize(f.shelf_names),
    ARRAY(
      SELECT DISTINCT search_code(raw.code)
      FROM unnest(f.raw_codes) AS raw(code)
      WHERE length(search_code(raw.code)) >= 3
    ),
    f.text_a, f.text_b, f.text_c, f.text_d,
    now()
  FROM fields f
  CROSS JOIN LATERAL (
    SELECT search_normalize(split_part(
      regexp_replace(f.title, '\s[-|]\s|[,(\[]', chr(1), 'g'), chr(1), 1
    )) AS value
  ) AS core
  ON CONFLICT (product_id) DO UPDATE SET
    document = EXCLUDED.document,
    title_norm = EXCLUDED.title_norm,
    title_core = EXCLUDED.title_core,
    title_words = EXCLUDED.title_words,
    brand_norm = EXCLUDED.brand_norm,
    category_norm = EXCLUDED.category_norm,
    codes = EXCLUDED.codes,
    text_a = EXCLUDED.text_a,
    text_b = EXCLUDED.text_b,
    text_c = EXCLUDED.text_c,
    text_d = EXCLUDED.text_d,
    indexed_at = EXCLUDED.indexed_at;

  DELETE FROM product_search_words WHERE product_id = ANY(ids);

  INSERT INTO product_search_words (product_id, word, display, weight)
  SELECT DISTINCT ON (w.product_id, w.word) w.product_id, w.word, w.display, w.weight
  FROM (
    SELECT ps.product_id,
           lower(token) AS word,
           CASE WHEN field.weight >= 3 THEN token ELSE lower(token) END AS display,
           field.weight
    FROM product_search ps
    CROSS JOIN LATERAL (VALUES
      (ps.text_a, 4), (ps.text_b, 3), (ps.text_c, 2), (ps.text_d, 1)
    ) AS field(body, weight)
    CROSS JOIN LATERAL regexp_split_to_table(field.body, '[^[:alnum:]]+') AS token
    WHERE ps.product_id = ANY(ids)
    UNION ALL
    SELECT ps.product_id, lower(joined), joined, 3
    FROM product_search ps
    CROSS JOIN LATERAL regexp_split_to_table(
      search_joined(ps.text_a || ' ' || ps.text_b || ' ' || ps.text_c), ' '
    ) AS joined
    WHERE ps.product_id = ANY(ids)
  ) AS w
  WHERE length(w.word) BETWEEN 2 AND 32
  ORDER BY w.product_id, w.word, w.weight DESC, w.display;
END;
$$;
--> statement-breakpoint

-- Queues products for a rebuild at commit. Updating an existing row (rather
-- than doing nothing) matters: it is what re-arms the deferred trigger when a
-- row was left behind by a failed rebuild.
CREATE OR REPLACE FUNCTION queue_product_search(ids uuid[]) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO product_search_queue (product_id)
  SELECT DISTINCT t.product_id
  FROM unnest(ids) AS t(product_id)
  WHERE t.product_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = t.product_id)
  ON CONFLICT (product_id) DO UPDATE SET queued_at = now()
$$;
--> statement-breakpoint

-- Runs once per queued product at commit. The delete is what makes a product
-- queued fifty times in one transaction rebuild once: every event after the
-- first finds the row already gone. A failure is caught and logged rather than
-- raised, because a broken index row is not a reason to refuse a product save;
-- the row stays queued for the sweep.
CREATE OR REPLACE FUNCTION process_product_search_queue_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    DELETE FROM product_search_queue WHERE product_id = NEW.product_id;
    IF FOUND THEN
      PERFORM refresh_product_search(ARRAY[NEW.product_id]);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Search index rebuild failed for product %: %', NEW.product_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_search_queue_process" ON "product_search_queue";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "product_search_queue_process"
  AFTER INSERT OR UPDATE ON "product_search_queue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION process_product_search_queue_row();
--> statement-breakpoint

-- What queues a product ----------------------------------------------------------
CREATE OR REPLACE FUNCTION product_search_touch_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_search_insert" ON "products";
--> statement-breakpoint
CREATE TRIGGER "products_search_insert"
  AFTER INSERT ON "products"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_product();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_search_update" ON "products";
--> statement-breakpoint
-- Only the columns the document is built from. A status change, an archive or
-- a publish does not touch the index at all: visibility is decided live.
CREATE TRIGGER "products_search_update"
  AFTER UPDATE ON "products"
  FOR EACH ROW WHEN (
    OLD.title IS DISTINCT FROM NEW.title
    OR OLD.brand IS DISTINCT FROM NEW.brand
    OR OLD.sku IS DISTINCT FROM NEW.sku
    OR OLD.identifier_value IS DISTINCT FROM NEW.identifier_value
    OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.description_html IS DISTINCT FROM NEW.description_html
    OR OLD.bullet_features IS DISTINCT FROM NEW.bullet_features
    OR OLD.spec_table IS DISTINCT FROM NEW.spec_table
    OR OLD.box_contents IS DISTINCT FROM NEW.box_contents
    OR OLD.details IS DISTINCT FROM NEW.details
    OR OLD.attribute_values IS DISTINCT FROM NEW.attribute_values
    OR OLD.tags IS DISTINCT FROM NEW.tags
    OR OLD.search_keywords IS DISTINCT FROM NEW.search_keywords
    OR OLD.seo_meta_description IS DISTINCT FROM NEW.seo_meta_description
  )
  EXECUTE FUNCTION product_search_touch_product();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION product_search_touch_variant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM queue_product_search(ARRAY[NEW.product_id]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM queue_product_search(ARRAY[OLD.product_id]);
  ELSE
    PERFORM queue_product_search(ARRAY[OLD.product_id, NEW.product_id]);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_variants_search_change" ON "product_variants";
--> statement-breakpoint
CREATE TRIGGER "product_variants_search_change"
  AFTER INSERT OR DELETE ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_variant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_variants_search_update" ON "product_variants";
--> statement-breakpoint
-- Deliberately not the capacity or stock columns: a reservation inside the
-- checkout transaction must not pay for a reindex.
CREATE TRIGGER "product_variants_search_update"
  AFTER UPDATE ON "product_variants"
  FOR EACH ROW WHEN (
    OLD.sku IS DISTINCT FROM NEW.sku
    OR OLD.is_enabled IS DISTINCT FROM NEW.is_enabled
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
  )
  EXECUTE FUNCTION product_search_touch_variant();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION product_search_touch_option() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  variant_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    variant_ids := ARRAY[NEW.variant_id];
  ELSIF TG_OP = 'DELETE' THEN
    variant_ids := ARRAY[OLD.variant_id];
  ELSE
    variant_ids := ARRAY[OLD.variant_id, NEW.variant_id];
  END IF;

  PERFORM queue_product_search(ARRAY(
    SELECT v.product_id FROM product_variants v WHERE v.id = ANY(variant_ids)
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "variant_option_values_search_change" ON "variant_option_values";
--> statement-breakpoint
CREATE TRIGGER "variant_option_values_search_change"
  AFTER INSERT OR UPDATE OR DELETE ON "variant_option_values"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_option();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION product_search_touch_attribute_value() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    SELECT DISTINCT v.product_id
    FROM variant_option_values vov
    JOIN product_variants v ON v.id = vov.variant_id
    WHERE vov.attribute_value_id = NEW.id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "attribute_values_search_rename" ON "attribute_values";
--> statement-breakpoint
CREATE TRIGGER "attribute_values_search_rename"
  AFTER UPDATE ON "attribute_values"
  FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION product_search_touch_attribute_value();
--> statement-breakpoint

-- A shelf renamed or moved changes the words of everything beneath it.
CREATE OR REPLACE FUNCTION product_search_touch_category() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    WITH RECURSIVE subtree AS (
      SELECT NEW.id AS id, 0 AS depth
      UNION ALL
      SELECT c.id, s.depth + 1
      FROM categories c
      JOIN subtree s ON c.parent_id = s.id
      WHERE s.depth < 16
    )
    SELECT p.id FROM products p WHERE p.category_id IN (SELECT id FROM subtree)
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "categories_search_change" ON "categories";
--> statement-breakpoint
CREATE TRIGGER "categories_search_change"
  AFTER UPDATE ON "categories"
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
  )
  EXECUTE FUNCTION product_search_touch_category();
--> statement-breakpoint

-- A specification renamed, re-unitised, or taken out of search.
CREATE OR REPLACE FUNCTION product_search_touch_category_attribute() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  definition_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    definition_id := OLD.id::text;
  ELSE
    definition_id := NEW.id::text;
  END IF;

  PERFORM queue_product_search(ARRAY(
    SELECT p.id FROM products p
    WHERE jsonb_typeof(p.attribute_values) = 'object'
      AND p.attribute_values ? definition_id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "category_attributes_search_change" ON "category_attributes";
--> statement-breakpoint
CREATE TRIGGER "category_attributes_search_change"
  AFTER UPDATE ON "category_attributes"
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.unit IS DISTINCT FROM NEW.unit
    OR OLD.data_type IS DISTINCT FROM NEW.data_type
    OR OLD.is_searchable IS DISTINCT FROM NEW.is_searchable
  )
  EXECUTE FUNCTION product_search_touch_category_attribute();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "category_attributes_search_delete" ON "category_attributes";
--> statement-breakpoint
CREATE TRIGGER "category_attributes_search_delete"
  AFTER DELETE ON "category_attributes"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_category_attribute();
--> statement-breakpoint

-- The old single-table expression index is replaced by product_search.
DROP INDEX IF EXISTS "products_search_idx";
--> statement-breakpoint

-- Synonyms staff maintain ------------------------------------------------------
-- `term` is what a shopper types; `synonyms` is what else to look for. A
-- two-way entry also maps each synonym back to the term. Nothing here is ever
-- generated: a wrong synonym silently fills a result page with the wrong
-- products, so only staff write them.
CREATE TABLE IF NOT EXISTS "search_synonyms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "term" text NOT NULL,
  "synonyms" text[] NOT NULL,
  "bidirectional" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "search_synonyms_term_unique" UNIQUE ("term"),
  CONSTRAINT "search_synonyms_term_check" CHECK (length("term") BETWEEN 2 AND 60),
  CONSTRAINT "search_synonyms_count_check" CHECK (cardinality("synonyms") BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_synonyms_synonyms_idx"
  ON "search_synonyms" USING GIN ("synonyms");
--> statement-breakpoint

-- Search analytics --------------------------------------------------------------
-- No account and no address: a visitor is a keyed hash of the connection that
-- changes every day, which is enough to count people without being able to
-- follow one. One row per visitor, query and half hour, so paging through
-- results or refreshing does not count as searching again.
CREATE TABLE IF NOT EXISTS "search_queries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "query" text NOT NULL,
  "query_norm" text NOT NULL,
  "results_count" integer NOT NULL,
  "corrected_query" text,
  "visitor_hash" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "search_queries_visit_unique" UNIQUE ("visitor_hash", "query_norm", "window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_created_at_idx"
  ON "search_queries" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_norm_idx"
  ON "search_queries" ("query_norm", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "search_clicks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "query_norm" text NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "position" integer,
  "visitor_hash" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "search_clicks_visit_unique"
    UNIQUE ("visitor_hash", "query_norm", "product_id", "window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_clicks_created_at_idx"
  ON "search_clicks" ("created_at");
--> statement-breakpoint

-- A signed-in customer's own recent searches. Theirs to read and clear, and
-- removed with the account when it is anonymised.
CREATE TABLE IF NOT EXISTS "search_history" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "query" text NOT NULL,
  "query_norm" text NOT NULL,
  "searched_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "query_norm")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_history_recent_idx"
  ON "search_history" ("user_id", "searched_at" DESC);
--> statement-breakpoint

-- Indexes the discovery queries lean on ----------------------------------------
-- Best selling sums units per product through the variants.
CREATE INDEX IF NOT EXISTS "order_items_variant_id_idx" ON "order_items" ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_brand_idx" ON "products" ("brand");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_attribute_values_idx"
  ON "products" USING GIN ("attribute_values" jsonb_path_ops);
--> statement-breakpoint

-- Index everything that already exists.
SELECT refresh_product_search(ARRAY(SELECT id FROM products));
