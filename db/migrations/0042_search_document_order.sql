-- Stage 8: the search document is built in a fixed order.
--
-- `refresh_product_search` aggregated a listing's shelf specifications with
-- a string aggregate with no ORDER BY, so the order of those words followed
-- whatever order the plan happened to produce. It is stable for one call shape
-- and different for another: refreshing one listing on its own and refreshing it
-- as part of a batch of five thousand both store the same words in a different
-- order. Measured on the 5,000-listing scale database, a rebuild in chunks of
-- two hundred rewrote 3,863 of 5,000 documents with no change to the catalogue
-- behind them.
--
-- Two things depended on that order. Relevance within a tier uses
-- `ts_rank_cd`, which is a cover-density rank and therefore reads the positions
-- in the tsvector, so the same query against the same data could rank two
-- listings differently depending on how the index had last been rebuilt. And a
-- derived model that cannot be rebuilt to the same bytes cannot be *compared*
-- to its canonical source, which is the check this read model is supposed to
-- pass (invariant I-21).
--
-- The fix is the ordering the aggregate always needed: the shelf's own
-- `sort_order`, then the specification's name, then the key, which is unique
-- per listing. Nothing else about the function changes — this file is 0036's
-- definition with that one clause added.

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
        END, ' ' ORDER BY d.sort_order, d.name, e.key) AS words
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
