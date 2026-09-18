import { sql } from "drizzle-orm";
import { queryRows, textArray } from "./sql";
import { termKey } from "./terms";

/**
 * What the Product Knowledge Base says a search means (D-089, D-067).
 *
 * A search box gets words. The knowledge base holds entities: brands, product
 * families, products, variants and the controlled values of an attribute, each
 * with the other names people use for it. This turns the first into the
 * second, in one query per search, and returns two things for every phrase it
 * recognises:
 *
 *   * the structured terms it stands for, which `product_search.terms` can be
 *     matched against directly — `b:` a brand, `f:` a family, `p:` one exact
 *     product, `v:` a value;
 *   * the words it is also written as, which widen the full-text side exactly
 *     the way a staff-written synonym does. This is what makes "Logitec" find
 *     Logitech products whose own text never contains the misspelling.
 *
 * Only APPROVED aliases are read. A suggestion — including one this module's
 * own zero-result analysis produced — changes nothing a shopper sees until
 * someone with `search.manage` has decided on it. Nothing here writes.
 */

export type KnowledgeMatch = {
  /** Any one of these, present in `product_search.terms`, satisfies the phrase. */
  terms: string[];
  /** Other spellings, each already split into words. */
  words: string[][];
  /** The knowledge products the phrase names outright, if any. */
  productIds: string[];
};

export type KnowledgeMap = Map<string, KnowledgeMatch>;

type Row = {
  matched: string;
  term: string;
  label: string | null;
  product_id: string | null;
};

/** Every run of one to three consecutive words — what an entity name can span. */
export function phrasesIn(words: string[]): string[] {
  const phrases = new Set<string>();
  for (let start = 0; start < words.length; start++) {
    for (let length = 1; length <= 3 && start + length <= words.length; length++) {
      phrases.add(words.slice(start, length + start).join(" "));
    }
  }
  return [...phrases];
}

const asWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * The knowledge behind a set of phrases, keyed by the phrase as it was asked
 * for. One query; every branch is an indexed lookup on `search_term_key`
 * (migration 0036).
 */
export async function loadKnowledgeMap(phrases: string[]): Promise<KnowledgeMap> {
  const wanted = [...new Set(phrases.map(termKey).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const keys = textArray(wanted);

  const rows = await queryRows<Row>(sql`
    -- A brand, by its own name or by an approved alias of it.
    select search_term_key(b.name) as matched,
           'b:' || search_term_key(b.name_normalized) as term,
           b.name as label,
           null::uuid as product_id
    from pkb_brands b
    where b.status = 'active' and search_term_key(b.name) = any(${keys})
    union all
    select search_term_key(b.name_normalized), 'b:' || search_term_key(b.name_normalized), b.name, null::uuid
    from pkb_brands b
    where b.status = 'active' and search_term_key(b.name_normalized) = any(${keys})
    union all
    select search_term_key(a.alias), 'b:' || search_term_key(b.name_normalized), b.name, null::uuid
    from pkb_aliases a
    join pkb_brands b on b.id = a.brand_id and b.status = 'active'
    where a.status = 'approved' and a.target_kind = 'brand'
      and search_term_key(a.alias) = any(${keys})

    -- A product family, by its key, its name or an approved alias.
    union all
    select search_term_key(f.key), 'f:' || search_term_key(f.key), f.name, null::uuid
    from pkb_families f
    where f.status = 'approved' and search_term_key(f.key) = any(${keys})
    union all
    select search_term_key(f.name), 'f:' || search_term_key(f.key), f.name, null::uuid
    from pkb_families f
    where f.status = 'approved' and search_term_key(f.name) = any(${keys})
    union all
    select search_term_key(a.alias), 'f:' || search_term_key(f.key), f.name, null::uuid
    from pkb_aliases a
    join pkb_families f on f.id = a.family_id and f.status = 'approved'
    where a.status = 'approved' and a.target_kind = 'family'
      and search_term_key(a.alias) = any(${keys})

    -- One exact product, by an approved alias of it or of one of its variants.
    union all
    select search_term_key(a.alias), 'p:' || k.id::text, k.name, k.id
    from pkb_aliases a
    join pkb_products k on k.id = a.pkb_product_id and k.status = 'active'
    where a.status = 'approved' and a.target_kind = 'product'
      and search_term_key(a.alias) = any(${keys})
    union all
    select search_term_key(a.alias), 'p:' || k.id::text, k.name, k.id
    from pkb_aliases a
    join pkb_variants v on v.id = a.pkb_variant_id
    join pkb_products k on k.id = v.pkb_product_id and k.status = 'active'
    where a.status = 'approved' and a.target_kind = 'variant'
      and search_term_key(a.alias) = any(${keys})

    -- A controlled value ("Space Grey" for space_gray), by an approved alias.
    union all
    select search_term_key(a.alias), 'v:' || search_term_key(o.label), o.label, null::uuid
    from pkb_aliases a
    join pkb_attribute_options o on o.id = a.option_id and o.status = 'approved'
    where a.status = 'approved' and a.target_kind = 'option'
      and search_term_key(a.alias) = any(${keys})
  `);

  const byKey = new Map<string, KnowledgeMatch>();
  for (const row of rows) {
    const entry = byKey.get(row.matched) ?? { terms: [], words: [], productIds: [] };
    if (!entry.terms.includes(row.term)) entry.terms.push(row.term);
    const words = asWords(row.label ?? "");
    if (words.length > 0 && !entry.words.some((existing) => existing.join(" ") === words.join(" "))) {
      entry.words.push(words);
    }
    if (row.product_id && !entry.productIds.includes(row.product_id)) {
      entry.productIds.push(row.product_id);
    }
    byKey.set(row.matched, entry);
  }

  // Keyed by the phrase as the caller wrote it, not by its term key.
  const map: KnowledgeMap = new Map();
  for (const phrase of phrases) {
    const entry = byKey.get(termKey(phrase));
    if (entry) map.set(phrase, entry);
  }
  return map;
}
