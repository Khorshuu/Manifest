import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { PUBLIC_STATUSES } from "@/lib/catalog/products";
import {
  isStopword,
  slotTitlePatterns,
  slotTsQuery,
  type Slot,
} from "./normalize";

/**
 * The SQL a search is made of.
 *
 * Every fragment here assumes the query reads `products` joined to
 * `product_search` under the alias `ps`. Values always travel as bound
 * parameters; the only text written into the SQL is this file's own.
 */

export type SearchPlan = {
  /** What the shopper typed, cleaned — shown back to them and logged. */
  query: string;
  /** The same, normalised the way `search_normalize` does it. */
  normalized: string;
  /** Normalised words, at most eight. */
  words: string[];
  /** One per word or synonym-matched phrase. */
  slots: Slot[];
  /** Every slot ANDed, as tsquery text; null when nothing usable remains. */
  tsquery: string | null;
  /** The search as a code (SKU, barcode, model number), when it looks like one. */
  code: string | null;
  /** The original search, when this plan is a correction of one that found nothing. */
  correctedFrom: string | null;
};

/** A literal text array built from bound parameters. */
export function textArray(values: string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Runs a hand-written query and returns its rows, whichever driver is
 * underneath: postgres-js returns the rows themselves, PGlite (the tests)
 * returns them under `rows`.
 */
export async function queryRows<T>(query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The public predicate for a subquery that reads `products` as `alias`. */
export function isPublicAs(alias: "p"): SQL {
  return sql`${sql.raw(alias)}.archived_at is null
    and ${sql.raw(alias)}.status in (${sql.join(
      PUBLIC_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
    and ${sql.raw(alias)}.searchable`;
}

/**
 * Whether a listing answers the search.
 *
 * Every slot has to match (a second word narrows), and a slot matches through
 * the full-text document or as a substring of the name — the second is what
 * finds "board" inside "Keyboard". A search that looks like a code also
 * matches a product carrying exactly that code, whatever its words say.
 */
export function searchMatch(plan: SearchPlan): SQL {
  const slotConditions = plan.slots
    .map((slot) => {
      const alternatives: SQL[] = [];
      const tsquery = slotTsQuery(slot);
      if (tsquery) {
        alternatives.push(sql`ps.document @@ to_tsquery('english', ${tsquery})`);
      }
      for (const pattern of slotTitlePatterns(slot)) {
        alternatives.push(sql`ps.title_norm like ${pattern}`);
      }
      return alternatives.length > 0
        ? sql`(${sql.join(alternatives, sql` or `)})`
        : null;
    })
    .filter((condition): condition is SQL => condition !== null);

  // Nothing but stop words ("the", "to"): look for the text itself in names.
  const words =
    slotConditions.length > 0
      ? sql.join(slotConditions, sql` and `)
      : sql`ps.title_norm like ${`%${plan.normalized}%`}`;

  const match = plan.code
    ? sql`(ps.codes @> ${textArray([plan.code])} or (${words}))`
    : sql`(${words})`;

  // Hidden from search means hidden from search, whatever the words.
  return sql`(${products.searchable} and ${match})`;
}

/**
 * How relevant a listing is, as a tier. Ordering is by tier first, so nothing
 * computed within a tier — popularity, the staff boost, ratings — can lift a
 * weaker match above a stronger one (DECISIONS.md D-027).
 *
 *   9  the search is exactly one of its codes
 *   8  the search is its name (or its name after the brand)
 *   7  the search is its brand, or the brand followed by words from its name
 *   6  the search appears in its name, word for word
 *   5  every word appears in its name
 *   4  every word appears in its name, brand, model, keywords or shelf
 *   3  … or in its highlights, options and specifications
 *   2  … or anywhere in the listing
 *   1  matched only inside a word of the name
 */
export function relevanceTier(plan: SearchPlan): SQL {
  const q = plan.normalized;
  const full = plan.tsquery
    ? sql`to_tsquery('english', ${plan.tsquery})`
    : null;

  const code = plan.code
    ? sql`when ps.codes @> ${textArray([plan.code])} then 9`
    : sql``;

  const fields = full
    ? sql`
      when ts_filter(ps.document, '{a}') @@ ${full} then 5
      when ts_filter(ps.document, '{a,b}') @@ ${full} then 4
      when ts_filter(ps.document, '{a,b,c}') @@ ${full} then 3
      when ps.document @@ ${full} then 2`
    : sql``;

  return sql`(case
    ${code}
    when ps.title_norm = ${q} or ps.title_core = ${q}
      or (ps.brand_norm <> '' and (
        ps.title_norm = ps.brand_norm || ' ' || ${q}
        or ps.title_core = ps.brand_norm || ' ' || ${q}
      )) then 8
    when ps.brand_norm <> '' and (
        ps.brand_norm = ${q}
        or (
          ${q} like ps.brand_norm || ' %'
          and (' ' || ps.title_norm || ' ')
            like '% ' || substr(${q}, length(ps.brand_norm) + 2) || ' %'
        )
      ) then 7
    when (' ' || ps.title_norm || ' ') like ${`% ${q} %`} then 6
    ${fields}
    else 1
  end)`;
}

/**
 * Relevance within a tier, from the text alone.
 *
 * A name the search covers more of is a better answer ("iPhone 15" over
 * "iPhone 15 Silicone Case" for "iphone 15"); a name that ends with the search
 * is the thing itself rather than something for it; a name that starts with
 * it is what someone typing it usually wants. Then the full-text rank, and the
 * staff boost — twelve points a step, which moves a product within its tier
 * and never out of it.
 */
export function relevanceAdjustment(plan: SearchPlan): SQL {
  const q = plan.normalized;
  const counted = Math.max(
    1,
    plan.words.filter((word) => !isStopword(word)).length,
  );
  const rank = plan.tsquery
    ? sql`+ 10 * ts_rank_cd(ps.document, to_tsquery('english', ${plan.tsquery}), 32)`
    : sql``;

  return sql`(
    30.0 * least(1.0, ${counted}::float8 / greatest(ps.title_words, 1))
    + case when (' ' || ps.title_core) like ${`% ${q}`} then 15 else 0 end
    + case when ps.title_norm like ${`${q}%`} then 10 else 0 end
    ${rank}
    + 12 * ${products.searchBoost}
  )`;
}
