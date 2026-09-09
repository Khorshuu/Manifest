import { sql, type SQL } from "drizzle-orm";
import { products } from "@/db/schema";

/**
 * What "search" means in this shop.
 *
 * It used to mean `title ILIKE '%term%' OR brand ILIKE '%term%'`. That finds a
 * product only for someone who already knows its name, which is the one
 * shopper who does not need a search box. Someone typing "tactile" is
 * describing a switch; someone typing "office" is describing a use. Those
 * words are in the listing — in its description, its bullet points, its spec
 * table, its tags — so those are what is searched.
 *
 * Four things can match, in this order of confidence:
 *
 *  1. The listing's own text, through Postgres full-text search.
 *  2. Its category's name, so "electronics" finds what is filed there.
 *  3. Its variants' attribute values, so "matte black" finds the product that
 *     comes in matte black.
 *  4. The title as a plain substring, which is what catches a search inside a
 *     word ("board" in "Keyboard") that a stemmed prefix query cannot.
 *
 * The document expression below is duplicated, deliberately and with this
 * comment on both sides, in `db/migrations/0012_product_search.sql`. Postgres
 * only uses an expression index when the query's expression matches it
 * exactly, so the two have to be kept identical — a mismatch does not break
 * search, it silently makes it a sequential scan.
 */
const SEARCH_DOCUMENT = sql`to_tsvector(
  'english',
  coalesce(${products.title}, '') || ' ' ||
  coalesce(${products.brand}, '') || ' ' ||
  coalesce(regexp_replace(${products.descriptionHtml}, '<[^>]*>', ' ', 'g'), '') || ' ' ||
  coalesce(${products.tags}::text, '') || ' ' ||
  coalesce(${products.bulletFeatures}::text, '') || ' ' ||
  coalesce(${products.specTable}::text, '') || ' ' ||
  coalesce(${products.seoMetaDescription}, '')
)`;

/** No more than this many words are taken from one search. */
const MAX_TERMS = 8;

/**
 * Turns what someone typed into a tsquery string.
 *
 * Every term becomes a prefix match, which is what makes "key" find
 * "keyboard" while the search is still being typed, and the terms are ANDed,
 * because a second word a shopper types is a narrowing, not an alternative.
 *
 * The input is rewritten rather than escaped: only letters, digits and spaces
 * survive, so none of tsquery's own operators can arrive from a search box.
 * That is also why this returns null for a search with nothing usable in it —
 * an empty tsquery is a syntax error, not an empty result.
 */
export function toTsQuery(term: string): string | null {
  const words = term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS);

  if (words.length === 0) return null;

  return words.map((word) => `${word}:*`).join(" & ");
}

/** Everything a listing is searched by, as one condition. */
export function searchCondition(term: string): SQL | null {
  const query = toTsQuery(term);
  if (!query) return null;

  const anywhere = `%${term.trim()}%`;

  return sql`(
    ${SEARCH_DOCUMENT} @@ to_tsquery('english', ${query})
    or ${products.title} ilike ${anywhere}
    or exists (
      select 1 from categories c
      where c.id = ${products.categoryId} and c.name ilike ${anywhere}
    )
    or exists (
      select 1
      from variant_option_values vov
      join product_variants v on v.id = vov.variant_id
      join attribute_values av on av.id = vov.attribute_value_id
      where v.product_id = ${products.id}
        and v.is_enabled = true and v.archived_at is null
        and av.value ilike ${anywhere}
    )
  )`;
}

/**
 * How well a listing answers a search, as a number to sort by.
 *
 * The text rank does the work; the two bonuses settle what a rank alone gets
 * wrong. A product whose *name* starts with what was typed is what the shopper
 * meant far more often than a product that merely mentions it in a paragraph,
 * and `ts_rank_cd` has no way to know which field a match came from.
 */
export function searchRank(term: string): SQL {
  const query = toTsQuery(term);
  const trimmed = term.trim();
  const prefix = `${trimmed}%`;
  const anywhere = `%${trimmed}%`;

  const textRank = query
    ? sql`ts_rank_cd(${SEARCH_DOCUMENT}, to_tsquery('english', ${query}))`
    : sql`0`;

  return sql`(
    ${textRank}
    + case when ${products.title} ilike ${prefix} then 1.0 else 0 end
    + case when ${products.title} ilike ${anywhere} then 0.5 else 0 end
  )`;
}
