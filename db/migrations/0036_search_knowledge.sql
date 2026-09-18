-- Stage 5 of the knowledge platform: SearchPulse reads the knowledge base
-- (D-089 to D-095).
--
-- Until now the search index was built from the listing's own columns: free
-- text in `details`, raw strings in `attribute_values`, option names typed per
-- product. That is why "Color" and "Colour" were two filters (finding F12) and
-- why "256GB" and "256 GB" never compared (finding F11).
--
-- The knowledge base already holds those same values normalized, typed, with a
-- unit and a definition behind each one. This migration makes the index read
-- them, without giving search a second copy of product truth: everything below
-- is derived, rebuilt by the same deferred trigger machinery migration 0014
-- introduced, and can be thrown away and rebuilt from `pkb_*` at any time.
--
-- What is added:
--
--   * `search_term_key` and `search_number`, the two comparison forms a query
--     and an indexed value must agree on. `lib/search/terms.ts` mirrors them
--     character for character, and `tests/search-knowledge.test.ts` proves the
--     two agree by running both over the same inputs.
--   * four columns on `product_search` — the brand key, the family keys, the
--     approved aliases, and `terms`, the structured signals a query can match
--     without a join.
--   * `product_search_attributes`, the facet read model: one row per product,
--     attribute and value, carrying the definition's key, its label, the
--     normalized value and its unit, and the older URL keys the same filter
--     used to travel under so no shared link breaks.
--   * `search_events`, the privacy-safe first-party events the search report
--     could not measure before (filters, refinements, add to cart, purchase).
--
-- What is NOT changed: the weighted document, the ranking tiers, the typo
-- vocabulary, `search_synonyms`, `search_queries`, `search_clicks` and
-- `search_history` all keep their meaning. The legacy sources stay in the
-- index beside the knowledge ones, so a value the knowledge base has not
-- mapped yet is still searchable and still filterable (Stage 7 contracts
-- them once nothing reads them).

-- 1. The two comparison forms -------------------------------------------------
-- A term key: lower case, "&" spelled out, every run of anything else one
-- underscore. Deliberately does NOT fold accents — neither does the query
-- side, and folding on one side only would make "Crème" unfindable.
CREATE OR REPLACE FUNCTION search_term_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT replace(
      btrim(
        regexp_replace(
          regexp_replace(lower(coalesce(value, '')), '&', ' and ', 'g'),
          '[^[:alnum:]]+', ' ', 'g'
        ),
        ' '
      ),
      ' ', '_'
    )
  $$;
--> statement-breakpoint

-- A normalized quantity as text, with no trailing zeros, so the database and
-- `formatDecimal` in TypeScript write the same number the same way.
CREATE OR REPLACE FUNCTION search_number(value numeric) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN value IS NULL THEN NULL ELSE trim_scale(value)::text END $$;
--> statement-breakpoint

-- 2. What the index now carries -----------------------------------------------
-- The knowledge base's brand key, or the listing's brand when it has no
-- knowledge brand yet. One key per brand entity, so spelling variants of one
-- brand stop being different facets (finding F10).
ALTER TABLE "product_search" ADD COLUMN IF NOT EXISTS "brand_key" text NOT NULL DEFAULT '';
--> statement-breakpoint
-- The product's family and every family above it.
ALTER TABLE "product_search" ADD COLUMN IF NOT EXISTS "family_keys" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- Approved aliases of this product and its variants, as term keys.
ALTER TABLE "product_search" ADD COLUMN IF NOT EXISTS "alias_keys" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- The structured signals a query can match. Every entry is prefixed by what
-- kind of signal it is, so nothing can collide by accident:
--   p:<pkb product id>        this exact product
--   b:<brand key>             its brand
--   f:<family key>            its family, or one above it
--   a:<definition>=<value>    a named attribute with a named value
--   v:<value>                 that value, whichever attribute holds it
--   q:<definition>=<number>   a named quantity, in its canonical unit
--   u:<dimension>=<number>    that quantity, whichever attribute holds it
ALTER TABLE "product_search" ADD COLUMN IF NOT EXISTS "terms" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "product_search_terms_idx" ON "product_search" USING GIN ("terms");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_alias_keys_idx" ON "product_search" USING GIN ("alias_keys");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_brand_key_idx" ON "product_search" ("brand_key");
--> statement-breakpoint

-- 3. The facet read model ------------------------------------------------------
-- One row per product, attribute and distinct value. Derived: never written by
-- hand, rebuilt whole for a product whenever anything it reads changes.
CREATE TABLE IF NOT EXISTS "product_search_attributes" (
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  -- The attribute's canonical URL key: the definition's key with hyphens
  -- ("screen-size"), or the legacy attribute's slug while it has no definition.
  "url_key" text NOT NULL,
  -- Keys this same filter used to travel under — the definition's label, the
  -- category specifications mapped onto it, the option groups linked to it.
  -- An old shared link keeps working, and the two never become two filters.
  "alt_keys" text[] NOT NULL DEFAULT '{}',
  "label" text NOT NULL,
  -- The comparison form of the value. For a quantity this is the canonical
  -- number and unit, which is what makes "256GB" and "256 GB" one value.
  "value_key" text NOT NULL,
  -- Forms the same value used to be filtered by, for the same reason.
  "value_alt_keys" text[] NOT NULL DEFAULT '{}',
  "value_label" text NOT NULL,
  "value_number" numeric,
  "value_unit" text,
  "display_unit" text,
  "data_type" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 1000,
  -- knowledge | legacy_option | legacy_spec — what the row was built from, so
  -- the coverage of the migration can be measured rather than assumed.
  "source" text NOT NULL,
  "searchable" boolean NOT NULL DEFAULT true,
  "filterable" boolean NOT NULL DEFAULT true,
  "variant_defining" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("product_id", "url_key", "value_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_attributes_key_idx"
  ON "product_search_attributes" ("url_key", "value_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_attributes_alt_idx"
  ON "product_search_attributes" USING GIN ("alt_keys");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_search_attributes_value_alt_idx"
  ON "product_search_attributes" USING GIN ("value_alt_keys");
--> statement-breakpoint

-- 3b. How a stored value reads ---------------------------------------------------
-- One definition of what a person sees for a fact, shared by the document and
-- by the filter, so the two can never say it differently.
--
-- The display unit is put back only when the value does not already carry it.
-- A category specification whose unit is free text stores "8" with unit "GB"
-- and needs it; one whose value could not be parsed keeps the whole phrase
-- staff typed ("16 - 300 ohm") and must not be given a second "ohm".
CREATE OR REPLACE FUNCTION value_reads(
  data_type text,
  raw_value text,
  value_text text,
  value_number numeric,
  value_unit text,
  value_boolean boolean,
  value_date date,
  option_label text,
  brand_name text,
  display_unit text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN base IS NULL OR base = '' THEN NULL
    WHEN data_type IN ('number', 'text')
     AND display_unit IS NOT NULL
     AND lower(right(base, length(display_unit))) IS DISTINCT FROM lower(display_unit)
      THEN base || ' ' || display_unit
    ELSE base
  END
  FROM (
    SELECT CASE
      WHEN option_label IS NOT NULL THEN option_label
      WHEN brand_name IS NOT NULL THEN brand_name
      WHEN data_type = 'boolean' AND value_boolean IS NOT NULL THEN
        CASE WHEN value_boolean THEN 'Yes' ELSE 'No' END
      WHEN data_type IN ('quantity', 'quantity_range') AND value_number IS NOT NULL THEN
        coalesce(nullif(raw_value, ''), search_number(value_number) || coalesce(' ' || value_unit, ''))
      WHEN value_text IS NOT NULL THEN value_text
      WHEN value_date IS NOT NULL THEN value_date::text
      ELSE nullif(raw_value, '')
    END AS base
  ) AS chosen
$$;
--> statement-breakpoint

-- 4. The index builder ----------------------------------------------------------
-- Replaces the 0014 version. Everything that was indexed before is still
-- indexed; the knowledge base is added beside it.
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

  -- ---------------------------------------------------------------- knowledge
  -- The listing's knowledge product, and the live offers' knowledge variants.
  -- A disabled or archived offer is not something a shopper can choose, so its
  -- variant facts are left out of both the words and the filters.
  knowledge AS (
    SELECT t.id AS product_id, k.id AS pkb_product_id, k.family_id
    FROM targets t
    JOIN pkb_products k ON k.id = t.pkb_product_id AND k.status = 'active'
  ),
  live_variants AS (
    SELECT DISTINCT v.product_id, v.pkb_variant_id
    FROM product_variants v
    WHERE v.product_id = ANY(ids)
      AND v.is_enabled AND v.archived_at IS NULL
      AND v.pkb_variant_id IS NOT NULL
  ),
  family_tree AS (
    SELECT kn.product_id, f.id, f.key, f.name, 0 AS depth, f.parent_id
    FROM knowledge kn
    JOIN pkb_families f ON f.id = kn.family_id
    UNION ALL
    SELECT ft.product_id, f.id, f.key, f.name, ft.depth + 1, f.parent_id
    FROM family_tree ft
    JOIN pkb_families f ON f.id = ft.parent_id
    WHERE ft.depth < 16
  ),
  families AS (
    SELECT product_id,
           array_agg(DISTINCT search_term_key(key)) AS keys,
           -- The family's readable name is what goes in the document; its key
           -- is a machine form and would stem into nonsense.
           string_agg(DISTINCT name, ' ') AS words
    FROM family_tree
    GROUP BY product_id
  ),
  -- Every attribute a family in the lineage declares, nearest family winning,
  -- which is the same rule `resolveFamilySchema` applies in TypeScript.
  family_schema AS (
    SELECT DISTINCT ON (ft.product_id, fa.definition_id)
      ft.product_id, fa.definition_id, fa.searchable, fa.filterable,
      fa.variant_defining, fa.sort_order
    FROM family_tree ft
    JOIN pkb_family_versions fv ON fv.family_id = ft.id AND fv.status = 'active'
    JOIN pkb_family_attributes fa ON fa.family_version_id = fv.id
    ORDER BY ft.product_id, fa.definition_id, ft.depth
  ),
  -- One row per accepted fact that belongs to this listing: product-level
  -- facts, plus the facts of the variants a shopper can actually buy.
  facts AS (
    SELECT
      kn.product_id,
      f.definition_id,
      d.key AS definition_key,
      d.label AS definition_label,
      d.data_type,
      d.unit_dimension,
      d.display_unit,
      coalesce(fs.searchable, d.searchable) AS searchable,
      coalesce(fs.filterable, d.filterable) AS filterable,
      coalesce(fs.variant_defining, false) AS variant_defining,
      coalesce(fs.sort_order, 1000) AS sort_order,
      f.value_status,
      f.raw_value,
      f.value_text,
      f.value_number,
      f.value_unit,
      f.value_boolean,
      f.value_date,
      o.label AS option_label,
      b.name AS brand_name,
      b.name_normalized AS brand_normalized,
      f.ordinal
    FROM knowledge kn
    JOIN pkb_facts f ON f.pkb_product_id = kn.pkb_product_id
    JOIN pkb_attribute_definitions d ON d.id = f.definition_id
    LEFT JOIN pkb_attribute_options o ON o.id = f.value_option_id
    LEFT JOIN pkb_brands b ON b.id = f.value_brand_id
    LEFT JOIN family_schema fs
      ON fs.product_id = kn.product_id AND fs.definition_id = f.definition_id
    WHERE f.value_status <> 'not_applicable'
      AND (
        f.pkb_variant_id IS NULL
        OR EXISTS (
          SELECT 1 FROM live_variants lv
          WHERE lv.product_id = kn.product_id AND lv.pkb_variant_id = f.pkb_variant_id
        )
      )
  ),
  -- How each fact reads, and how it compares. `value_display` is what a person
  -- sees in a filter; `value_key` is what a URL and a query are matched on.
  fact_values AS (
    SELECT
      fa.*,
      display.value AS value_display,
      CASE
        WHEN fa.data_type IN ('quantity', 'quantity_range') AND fa.value_number IS NOT NULL THEN
          search_number(fa.value_number) || coalesce('_' || search_term_key(fa.value_unit), '')
        WHEN fa.option_label IS NOT NULL THEN search_term_key(fa.option_label)
        WHEN fa.brand_normalized IS NOT NULL THEN search_term_key(fa.brand_normalized)
        WHEN fa.data_type = 'boolean' AND fa.value_boolean IS NOT NULL THEN
          CASE WHEN fa.value_boolean THEN 'yes' ELSE 'no' END
        WHEN fa.value_text IS NOT NULL THEN search_term_key(fa.value_text)
        WHEN fa.value_date IS NOT NULL THEN search_term_key(fa.value_date::text)
        ELSE search_term_key(fa.raw_value)
      END AS value_key
    FROM facts fa
    CROSS JOIN LATERAL (SELECT value_reads(
      fa.data_type, fa.raw_value, fa.value_text, fa.value_number, fa.value_unit,
      fa.value_boolean, fa.value_date, fa.option_label, fa.brand_name, fa.display_unit
    ) AS value) AS display
  ),
  -- The structured signals. Built only from searchable attributes: an internal
  -- note or a care instruction has no business answering a search.
  fact_terms AS (
    SELECT fv.product_id, term
    FROM fact_values fv
    CROSS JOIN LATERAL (
      SELECT unnest(ARRAY[
        'a:' || search_term_key(fv.definition_key) || '=' || fv.value_key,
        CASE WHEN fv.data_type IN ('quantity', 'quantity_range') AND fv.value_number IS NOT NULL
          THEN 'q:' || search_term_key(fv.definition_key) || '=' || search_number(fv.value_number)
               || coalesce('_' || search_term_key(fv.value_unit), '')
        END,
        CASE WHEN fv.data_type IN ('quantity', 'quantity_range') AND fv.value_number IS NOT NULL
              AND fv.unit_dimension IS NOT NULL
          THEN 'u:' || search_term_key(fv.unit_dimension) || '=' || search_number(fv.value_number)
        END,
        -- The bare value, so "black" finds a black thing whichever attribute
        -- records the colour. Numbers are left out: a query word "256" must
        -- not match every product with 256 of anything.
        CASE WHEN fv.data_type NOT IN ('quantity', 'quantity_range', 'number', 'date')
              AND fv.value_key ~ '[[:alpha:]]'
          THEN 'v:' || fv.value_key
        END
      ]) AS term
    ) AS t(term)
    WHERE fv.searchable AND fv.value_key IS NOT NULL AND fv.value_key <> ''
  ),
  -- Words the knowledge base contributes to the document: the attribute's
  -- label and its value, so "storage capacity 256 GB" is vocabulary the same
  -- way a category specification always was.
  fact_words AS (
    SELECT product_id,
           string_agg(DISTINCT definition_label || ' ' || value_display, ' ') AS words
    FROM fact_values
    WHERE searchable AND value_display IS NOT NULL AND value_display <> ''
    GROUP BY product_id
  ),
  -- Trade identifiers the knowledge base holds, in every form someone types
  -- them: the number as written, its normalized form, and the GTIN-14.
  knowledge_codes AS (
    SELECT kn.product_id, array_agg(DISTINCT code) AS list, string_agg(DISTINCT code, ' ') AS words
    FROM knowledge kn
    JOIN pkb_identifiers pi ON pi.pkb_product_id = kn.pkb_product_id
    CROSS JOIN LATERAL (
      SELECT unnest(ARRAY[pi.value_raw, pi.value_normalized, pi.gtin14]) AS code
    ) AS c(code)
    WHERE code IS NOT NULL AND code <> ''
      AND (
        pi.pkb_variant_id IS NULL
        OR EXISTS (
          SELECT 1 FROM live_variants lv
          WHERE lv.product_id = kn.product_id AND lv.pkb_variant_id = pi.pkb_variant_id
        )
      )
    GROUP BY kn.product_id
  ),
  -- Approved aliases naming this product or one of its variants. Suggested
  -- ones count for nothing: an alias is reusable knowledge only once someone
  -- with `search.manage` has said so (D-067).
  knowledge_aliases AS (
    SELECT kn.product_id,
           array_agg(DISTINCT search_term_key(a.alias)) AS keys,
           string_agg(DISTINCT a.alias, ' ') AS words
    FROM knowledge kn
    JOIN pkb_aliases a
      ON a.status = 'approved'
     AND (
       a.pkb_product_id = kn.pkb_product_id
       OR a.pkb_variant_id IN (
         SELECT lv.pkb_variant_id FROM live_variants lv WHERE lv.product_id = kn.product_id
       )
     )
    GROUP BY kn.product_id
  ),
  knowledge_brand AS (
    SELECT DISTINCT ON (kn.product_id) kn.product_id, b.name, b.name_normalized
    FROM knowledge kn
    JOIN pkb_facts f
      ON f.pkb_product_id = kn.pkb_product_id
     AND f.pkb_variant_id IS NULL
     AND f.value_brand_id IS NOT NULL
    JOIN pkb_attribute_definitions d ON d.id = f.definition_id AND d.key = 'brand'
    JOIN pkb_brands b ON b.id = f.value_brand_id AND b.status = 'active'
    ORDER BY kn.product_id, f.ordinal
  ),

  fields AS (
    SELECT
      t.id AS product_id,
      t.title,
      coalesce(t.brand, '') AS brand,
      t.title AS text_a,
      concat_ws(' ',
        t.brand,
        kb.name,
        t.details ->> 'manufacturer',
        t.details ->> 'modelName',
        t.details ->> 'modelNumber',
        t.details ->> 'manufacturerPartNumber',
        t.sku,
        t.identifier_value,
        s.words,
        kc.words,
        ka.words,
        fam.words,
        search_json_text(t.search_keywords),
        sh.names
      ) AS text_b,
      concat_ws(' ',
        search_json_text(t.bullet_features),
        o.option_values,
        sp.words,
        fw.words,
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
      ] || coalesce(s.list, '{}'::text[]) || coalesce(kc.list, '{}'::text[]) AS raw_codes,
      -- The knowledge brand when there is one, the listing's text when not.
      search_term_key(coalesce(kb.name_normalized, t.brand, '')) AS brand_key,
      coalesce(fam.keys, '{}'::text[]) AS family_keys,
      coalesce(ka.keys, '{}'::text[]) AS alias_keys,
      kn.pkb_product_id
    FROM targets t
    LEFT JOIN shelf sh ON sh.product_id = t.id
    LEFT JOIN options o ON o.product_id = t.id
    LEFT JOIN skus s ON s.product_id = t.id
    LEFT JOIN specs sp ON sp.product_id = t.id
    LEFT JOIN knowledge kn ON kn.product_id = t.id
    LEFT JOIN knowledge_brand kb ON kb.product_id = t.id
    LEFT JOIN knowledge_codes kc ON kc.product_id = t.id
    LEFT JOIN knowledge_aliases ka ON ka.product_id = t.id
    LEFT JOIN families fam ON fam.product_id = t.id
    LEFT JOIN fact_words fw ON fw.product_id = t.id
  )
  INSERT INTO product_search AS ps (
    product_id, document, title_norm, title_core, title_words, brand_norm,
    category_norm, codes, text_a, text_b, text_c, text_d,
    brand_key, family_keys, alias_keys, terms, indexed_at
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
    f.brand_key,
    f.family_keys,
    f.alias_keys,
    ARRAY(
      SELECT DISTINCT term FROM (
        SELECT 'p:' || f.pkb_product_id::text AS term WHERE f.pkb_product_id IS NOT NULL
        UNION ALL
        SELECT 'b:' || f.brand_key WHERE f.brand_key <> ''
        UNION ALL
        SELECT 'f:' || key FROM unnest(f.family_keys) AS k(key)
        UNION ALL
        SELECT ft.term FROM fact_terms ft WHERE ft.product_id = f.product_id AND ft.term IS NOT NULL
      ) AS all_terms
    ),
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
    brand_key = EXCLUDED.brand_key,
    family_keys = EXCLUDED.family_keys,
    alias_keys = EXCLUDED.alias_keys,
    terms = EXCLUDED.terms,
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

  PERFORM refresh_product_search_attributes(ids);
END;
$$;
--> statement-breakpoint

-- The facet read model, rebuilt for the same set of products.
--
-- Three sources, in this order of authority: the knowledge base, the option
-- groups it has not mapped yet, and the category specifications it has not
-- mapped yet. A value that exists in the knowledge base is never taken from
-- the listing as well, so nothing is counted twice.
CREATE OR REPLACE FUNCTION refresh_product_search_attributes(ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM product_search_attributes WHERE product_id = ANY(ids);

  WITH RECURSIVE
  knowledge AS (
    SELECT p.id AS product_id, k.id AS pkb_product_id, k.family_id
    FROM products p
    JOIN pkb_products k ON k.id = p.pkb_product_id AND k.status = 'active'
    WHERE p.id = ANY(ids)
  ),
  live_variants AS (
    SELECT DISTINCT v.product_id, v.pkb_variant_id
    FROM product_variants v
    WHERE v.product_id = ANY(ids)
      AND v.is_enabled AND v.archived_at IS NULL
      AND v.pkb_variant_id IS NOT NULL
  ),
  family_tree AS (
    SELECT kn.product_id, f.id, 0 AS depth, f.parent_id
    FROM knowledge kn
    JOIN pkb_families f ON f.id = kn.family_id
    UNION ALL
    SELECT ft.product_id, f.id, ft.depth + 1, f.parent_id
    FROM family_tree ft
    JOIN pkb_families f ON f.id = ft.parent_id
    WHERE ft.depth < 16
  ),
  family_schema AS (
    SELECT DISTINCT ON (ft.product_id, fa.definition_id)
      ft.product_id, fa.definition_id, fa.searchable, fa.filterable,
      fa.variant_defining, fa.sort_order
    FROM family_tree ft
    JOIN pkb_family_versions fv ON fv.family_id = ft.id AND fv.status = 'active'
    JOIN pkb_family_attributes fa ON fa.family_version_id = fv.id
    ORDER BY ft.product_id, fa.definition_id, ft.depth
  ),
  facts AS (
    SELECT
      kn.product_id,
      f.definition_id,
      d.key AS definition_key,
      d.label AS definition_label,
      d.data_type,
      d.display_unit,
      coalesce(fs.searchable, d.searchable) AS searchable,
      coalesce(fs.filterable, d.filterable) AS filterable,
      coalesce(fs.variant_defining, false) AS variant_defining,
      coalesce(fs.sort_order, 1000) AS sort_order,
      f.raw_value, f.value_text, f.value_number, f.value_unit,
      f.value_boolean, f.value_date, f.ordinal,
      o.label AS option_label, o.sort_order AS option_sort,
      b.name AS brand_name, b.name_normalized AS brand_normalized
    FROM knowledge kn
    JOIN pkb_facts f ON f.pkb_product_id = kn.pkb_product_id
    JOIN pkb_attribute_definitions d ON d.id = f.definition_id
    LEFT JOIN pkb_attribute_options o ON o.id = f.value_option_id
    LEFT JOIN pkb_brands b ON b.id = f.value_brand_id
    LEFT JOIN family_schema fs
      ON fs.product_id = kn.product_id AND fs.definition_id = f.definition_id
    WHERE f.value_status <> 'not_applicable'
      AND (
        f.pkb_variant_id IS NULL
        OR EXISTS (
          SELECT 1 FROM live_variants lv
          WHERE lv.product_id = kn.product_id AND lv.pkb_variant_id = f.pkb_variant_id
        )
      )
  ),
  -- Every older URL key this attribute answered to: its label, the category
  -- specifications mapped onto it, and the option groups linked to it.
  definition_alt_keys AS (
    SELECT d.id AS definition_id, array_agg(DISTINCT k) FILTER (WHERE k <> '') AS keys
    FROM pkb_attribute_definitions d
    CROSS JOIN LATERAL (
      SELECT search_slug(d.label) AS k
      UNION
      SELECT search_slug(ca.name)
      FROM pkb_legacy_attribute_map m
      JOIN category_attributes ca ON ca.id = m.category_attribute_id
      WHERE m.definition_id = d.id
      UNION
      SELECT search_slug(a.name) FROM attributes a WHERE a.attribute_definition_id = d.id
    ) AS alt(k)
    WHERE d.id IN (SELECT DISTINCT definition_id FROM facts)
    GROUP BY d.id
  ),
  knowledge_rows AS (
    SELECT
      fa.product_id,
      replace(search_term_key(fa.definition_key), '_', '-') AS url_key,
      coalesce(alt.keys, '{}'::text[]) AS alt_keys,
      fa.definition_label AS label,
      CASE
        WHEN fa.data_type IN ('quantity', 'quantity_range') AND fa.value_number IS NOT NULL THEN
          search_number(fa.value_number) || coalesce('_' || search_term_key(fa.value_unit), '')
        WHEN fa.option_label IS NOT NULL THEN search_term_key(fa.option_label)
        WHEN fa.brand_normalized IS NOT NULL THEN search_term_key(fa.brand_normalized)
        WHEN fa.data_type = 'boolean' AND fa.value_boolean IS NOT NULL THEN
          CASE WHEN fa.value_boolean THEN 'yes' ELSE 'no' END
        WHEN fa.value_text IS NOT NULL THEN search_term_key(fa.value_text)
        WHEN fa.value_date IS NOT NULL THEN search_term_key(fa.value_date::text)
        ELSE search_term_key(fa.raw_value)
      END AS value_key,
      -- What the value used to be filtered by: exactly the text on the
      -- listing, before it was normalized.
      ARRAY(
        SELECT DISTINCT search_term_key(v)
        FROM unnest(ARRAY[fa.raw_value, fa.value_text, fa.option_label, fa.brand_name]) AS r(v)
        WHERE v IS NOT NULL AND search_term_key(v) <> ''
      ) AS value_alt_keys,
      -- The same wording the document was built from, so a filter and the
      -- words a listing is searched by never disagree.
      value_reads(
        fa.data_type, fa.raw_value, fa.value_text, fa.value_number, fa.value_unit,
        fa.value_boolean, fa.value_date, fa.option_label, fa.brand_name, fa.display_unit
      ) AS value_label,
      fa.value_number,
      fa.value_unit,
      fa.display_unit,
      fa.data_type,
      coalesce(fa.option_sort, fa.ordinal) + fa.sort_order * 10000 AS sort_order,
      'knowledge'::text AS source,
      fa.searchable,
      fa.filterable,
      fa.variant_defining
    FROM facts fa
    LEFT JOIN definition_alt_keys alt ON alt.definition_id = fa.definition_id
  ),
  -- Option groups the knowledge base has no definition for yet. Without these
  -- a filter a shopper uses today would simply disappear (D-090).
  legacy_option_rows AS (
    SELECT DISTINCT
      v.product_id,
      search_slug(a.name) AS url_key,
      '{}'::text[] AS alt_keys,
      a.name AS label,
      search_term_key(av.value) AS value_key,
      '{}'::text[] AS value_alt_keys,
      av.value AS value_label,
      NULL::numeric AS value_number,
      NULL::text AS value_unit,
      NULL::text AS display_unit,
      'select'::text AS data_type,
      av.sort_order AS sort_order,
      'legacy_option'::text AS source,
      true AS searchable,
      true AS filterable,
      true AS variant_defining
    FROM product_variants v
    JOIN variant_option_values vov ON vov.variant_id = v.id
    JOIN attributes a ON a.id = vov.attribute_id
    JOIN attribute_values av ON av.id = vov.attribute_value_id
    WHERE v.product_id = ANY(ids)
      AND v.is_enabled AND v.archived_at IS NULL
      AND a.attribute_definition_id IS NULL
      AND search_slug(a.name) <> ''
      AND av.value <> ''
  ),
  -- Category specifications the knowledge base has not mapped yet.
  legacy_spec_rows AS (
    SELECT DISTINCT
      p.id AS product_id,
      search_slug(d.name) AS url_key,
      '{}'::text[] AS alt_keys,
      d.name AS label,
      search_term_key(x.value) AS value_key,
      '{}'::text[] AS value_alt_keys,
      CASE
        WHEN d.data_type = 'boolean' THEN CASE WHEN x.value = 'true' THEN 'Yes' ELSE 'No' END
        WHEN d.unit IS NOT NULL THEN x.value || ' ' || d.unit
        ELSE x.value
      END AS value_label,
      NULL::numeric AS value_number,
      NULL::text AS value_unit,
      d.unit AS display_unit,
      d.data_type,
      coalesce((
        SELECT t.ord::int
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(d.options) = 'array' THEN d.options ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(option, ord)
        WHERE t.option = x.value
      ), 1000) AS sort_order,
      'legacy_spec'::text AS source,
      d.is_searchable AS searchable,
      d.is_filterable AS filterable,
      false AS variant_defining
    FROM products p
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(p.attribute_values) = 'object'
        THEN p.attribute_values ELSE '{}'::jsonb END
    ) AS e(key, value)
    JOIN category_attributes d ON d.id::text = e.key
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE jsonb_typeof(e.value)
        WHEN 'array' THEN e.value
        ELSE jsonb_build_array(e.value)
      END
    ) AS x(value)
    WHERE p.id = ANY(ids)
      AND x.value <> ''
      AND search_slug(d.name) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM pkb_legacy_attribute_map m WHERE m.category_attribute_id = d.id
      )
  ),
  combined AS (
    SELECT * FROM knowledge_rows
    UNION ALL SELECT * FROM legacy_option_rows
    UNION ALL SELECT * FROM legacy_spec_rows
  )
  INSERT INTO product_search_attributes (
    product_id, url_key, alt_keys, label, value_key, value_alt_keys, value_label,
    value_number, value_unit, display_unit, data_type, sort_order, source,
    searchable, filterable, variant_defining
  )
  SELECT DISTINCT ON (product_id, url_key, value_key)
    product_id, url_key, alt_keys, label, value_key,
    -- However the value is written on the listing, and however it reads as a
    -- filter, both name it. A link carrying "8" and a link carrying "8 GB"
    -- select the same box.
    coalesce((
      SELECT array_agg(DISTINCT k)
      FROM unnest(value_alt_keys || ARRAY[search_term_key(value_label)]) AS t(k)
      WHERE k <> '' AND k <> value_key
    ), '{}'::text[]) AS value_alt_keys,
    value_label,
    value_number, value_unit, display_unit, data_type, sort_order, source,
    searchable, filterable, variant_defining
  FROM combined
  WHERE url_key <> '' AND value_key IS NOT NULL AND value_key <> ''
    AND value_label IS NOT NULL AND value_label <> ''
  -- The knowledge row wins over a legacy row that says the same thing.
  ORDER BY product_id, url_key, value_key,
           CASE source WHEN 'knowledge' THEN 0 WHEN 'legacy_option' THEN 1 ELSE 2 END,
           sort_order;
END;
$$;
--> statement-breakpoint

-- 5. What else queues a product now ---------------------------------------------
-- Accepting a claim, approving an alias, renaming a brand or changing what a
-- family says is searchable all change what a listing answers to, and none of
-- them necessarily touches the `products` row.

CREATE OR REPLACE FUNCTION product_search_touch_knowledge_product() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  knowledge_id uuid;
BEGIN
  -- OLD and NEW are only assigned for the operations that have them, so each
  -- one is read under its own branch rather than inside one expression.
  IF TG_OP = 'DELETE' THEN
    knowledge_id := OLD.pkb_product_id;
  ELSE
    knowledge_id := NEW.pkb_product_id;
  END IF;

  PERFORM queue_product_search(ARRAY(
    SELECT p.id FROM products p WHERE p.pkb_product_id = knowledge_id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "pkb_facts_search_change" ON "pkb_facts";
--> statement-breakpoint
CREATE TRIGGER "pkb_facts_search_change"
  AFTER INSERT OR UPDATE OR DELETE ON "pkb_facts"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_knowledge_product();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "pkb_identifiers_search_change" ON "pkb_identifiers";
--> statement-breakpoint
CREATE TRIGGER "pkb_identifiers_search_change"
  AFTER INSERT OR UPDATE OR DELETE ON "pkb_identifiers"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_knowledge_product();
--> statement-breakpoint

-- A product's own knowledge row: its family, or a merge.
CREATE OR REPLACE FUNCTION product_search_touch_knowledge_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    SELECT p.id FROM products p WHERE p.pkb_product_id = NEW.id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pkb_products_search_change" ON "pkb_products";
--> statement-breakpoint
CREATE TRIGGER "pkb_products_search_change"
  AFTER UPDATE ON "pkb_products"
  FOR EACH ROW WHEN (
    OLD.family_id IS DISTINCT FROM NEW.family_id
    OR OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION product_search_touch_knowledge_identity();
--> statement-breakpoint

-- An alias only changes search once it is approved or stops being approved.
CREATE OR REPLACE FUNCTION product_search_touch_alias() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  knowledge_ids uuid[] := '{}';
  variant_ids uuid[] := '{}';
  touched boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status = 'approved' THEN
    knowledge_ids := knowledge_ids || OLD.pkb_product_id;
    variant_ids := variant_ids || OLD.pkb_variant_id;
    touched := true;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.status = 'approved' THEN
    knowledge_ids := knowledge_ids || NEW.pkb_product_id;
    variant_ids := variant_ids || NEW.pkb_variant_id;
    touched := true;
  END IF;

  -- A suggested alias changes nothing a shopper sees, so nothing is rebuilt
  -- until someone approves it or takes the approval away.
  IF NOT touched THEN
    RETURN NULL;
  END IF;

  PERFORM queue_product_search(ARRAY(
    SELECT p.id FROM products p
    WHERE p.pkb_product_id = ANY(knowledge_ids)
       OR EXISTS (
            SELECT 1 FROM product_variants v
            WHERE v.product_id = p.id AND v.pkb_variant_id = ANY(variant_ids)
          )
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pkb_aliases_search_change" ON "pkb_aliases";
--> statement-breakpoint
CREATE TRIGGER "pkb_aliases_search_change"
  AFTER INSERT OR UPDATE OR DELETE ON "pkb_aliases"
  FOR EACH ROW EXECUTE FUNCTION product_search_touch_alias();
--> statement-breakpoint

-- A brand renamed or merged changes the words and the key of everything
-- carrying it.
CREATE OR REPLACE FUNCTION product_search_touch_brand() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    SELECT DISTINCT p.id
    FROM products p
    JOIN pkb_facts f ON f.pkb_product_id = p.pkb_product_id AND f.value_brand_id = NEW.id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pkb_brands_search_change" ON "pkb_brands";
--> statement-breakpoint
CREATE TRIGGER "pkb_brands_search_change"
  AFTER UPDATE ON "pkb_brands"
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION product_search_touch_brand();
--> statement-breakpoint

-- An attribute definition renamed, or taken out of search or out of the
-- filters, changes every listing that carries a value of it.
CREATE OR REPLACE FUNCTION product_search_touch_definition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    SELECT DISTINCT p.id
    FROM products p
    JOIN pkb_facts f ON f.pkb_product_id = p.pkb_product_id AND f.definition_id = NEW.id
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pkb_definitions_search_change" ON "pkb_attribute_definitions";
--> statement-breakpoint
CREATE TRIGGER "pkb_definitions_search_change"
  AFTER UPDATE ON "pkb_attribute_definitions"
  FOR EACH ROW WHEN (
    OLD.label IS DISTINCT FROM NEW.label
    OR OLD.key IS DISTINCT FROM NEW.key
    OR OLD.searchable IS DISTINCT FROM NEW.searchable
    OR OLD.filterable IS DISTINCT FROM NEW.filterable
    OR OLD.display_unit IS DISTINCT FROM NEW.display_unit
  )
  EXECUTE FUNCTION product_search_touch_definition();
--> statement-breakpoint

-- Activating a family version changes what is searchable and filterable for
-- every product in that family and every family below it.
CREATE OR REPLACE FUNCTION product_search_touch_family_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_product_search(ARRAY(
    WITH RECURSIVE subtree AS (
      SELECT NEW.family_id AS id, 0 AS depth
      UNION ALL
      SELECT f.id, s.depth + 1
      FROM pkb_families f JOIN subtree s ON f.parent_id = s.id
      WHERE s.depth < 16
    )
    SELECT p.id
    FROM products p
    JOIN pkb_products k ON k.id = p.pkb_product_id
    WHERE k.family_id IN (SELECT id FROM subtree)
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pkb_family_versions_search_change" ON "pkb_family_versions";
--> statement-breakpoint
CREATE TRIGGER "pkb_family_versions_search_change"
  AFTER UPDATE ON "pkb_family_versions"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION product_search_touch_family_version();
--> statement-breakpoint

-- 6. Reading the vocabulary from a search ----------------------------------------
-- Query understanding looks every one- to three-word run of a search up
-- against the brands, families and approved aliases, once per search. These
-- make that one indexed lookup rather than three scans.
CREATE INDEX IF NOT EXISTS "pkb_aliases_search_key_idx"
  ON "pkb_aliases" (search_term_key("alias")) WHERE "status" = 'approved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_brands_search_key_idx"
  ON "pkb_brands" (search_term_key("name_normalized"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_brands_search_name_idx"
  ON "pkb_brands" (search_term_key("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_families_search_key_idx"
  ON "pkb_families" (search_term_key("key"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkb_families_search_name_idx"
  ON "pkb_families" (search_term_key("name"));
--> statement-breakpoint

-- 7. First-party search events ---------------------------------------------------
-- What the search report could not say before: whether people filter, whether
-- they rephrase, and whether a search leads anywhere. Same privacy rules as
-- `search_queries` (D-029): a visitor is a keyed hash that changes daily, no
-- account id, no address, and a search shaped like an email or a phone number
-- is never stored at all.
--
-- A purchase row carries no visitor at all — by the time an order is placed
-- the attribution is a fact about the catalogue, not about a person.
CREATE TABLE IF NOT EXISTS "search_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_type" text NOT NULL,
  "query_norm" text NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE,
  "visitor_hash" text,
  "units" integer,
  -- Small and bounded: the filter keys used, or the query that was refined.
  "detail" jsonb,
  "window_start" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "search_events_type_check"
    CHECK ("event_type" IN ('filter', 'refine', 'add_to_cart', 'purchase')),
  CONSTRAINT "search_events_purchase_anonymous_check"
    CHECK ("event_type" <> 'purchase' OR "visitor_hash" IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_events_created_at_idx" ON "search_events" ("event_type", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_events_query_idx" ON "search_events" ("query_norm", "created_at");
--> statement-breakpoint
-- One row per visitor, query and half hour for the behavioural kinds, the same
-- rule the query log uses, so a refresh is not a second event.
CREATE UNIQUE INDEX IF NOT EXISTS "search_events_visit_unique"
  ON "search_events" ("event_type", "visitor_hash", "query_norm", coalesce("product_id", '00000000-0000-0000-0000-000000000000'::uuid), "window_start")
  WHERE "visitor_hash" IS NOT NULL;
--> statement-breakpoint

-- What a cart line was found through, so a purchase can be attributed without
-- following anybody. Cleared with the line; never leaves the shop.
ALTER TABLE "cart_items" ADD COLUMN IF NOT EXISTS "search_query_norm" text;
--> statement-breakpoint
COMMENT ON COLUMN "cart_items"."search_query_norm" IS 'The search this line was found through, if any. Read once at checkout to count the search as converting, then forgotten with the cart.';
--> statement-breakpoint
-- The same on the order line, and only until the payment is confirmed. A
-- search counts as converting when money actually arrives, not when an order
-- is placed — so the phrase has to survive the cart being emptied. It is
-- erased the moment it has been counted, so no order keeps a record of what
-- its customer searched for.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "search_query_norm" text;
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."search_query_norm" IS 'Carried from the cart only until the payment is confirmed, then cleared. Never a lasting record of what a customer searched for.';
--> statement-breakpoint

-- 8. Build it -------------------------------------------------------------------
-- Deterministic: the same catalogue produces the same rows, and running it
-- again changes nothing.
--
-- In batches rather than one call over the whole catalogue. The builder now
-- reads eight more tables, and at 5,000 listings one call takes about 71
-- seconds and holds every row it touches for all of it, while 200 at a time
-- takes about 0.6 seconds a batch — the same total work, in pieces short
-- enough that a large catalogue does not turn this migration into a long lock.
DO $$
DECLARE
  batch uuid[];
  last_id uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
    FROM (
      SELECT id FROM products WHERE id > last_id ORDER BY id LIMIT 200
    ) AS page;

    EXIT WHEN batch IS NULL;

    PERFORM refresh_product_search(batch);
    last_id := batch[array_length(batch, 1)];
  END LOOP;
END $$;
