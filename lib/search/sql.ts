import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { PUBLIC_STATUSES } from "@/lib/catalog/products";
import {
  isStopword,
  slotPartialPrefix,
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
  /** One per word, synonym- or alias-matched phrase, or quantity. */
  slots: Slot[];
  /** Every slot ANDed, as tsquery text; null when nothing usable remains. */
  tsquery: string | null;
  /**
   * The same over the positions a person reads — a typed quantity left out.
   * This is what the relevance tier is judged on (D-091).
   */
  readableTsquery: string | null;
  /** The words of those same positions, for judging how much of a name matched. */
  readableWords: string[];
  /**
   * `p:` terms for the knowledge products the whole search names outright,
   * through an approved alias. Empty for an ordinary search.
   */
  identityTerms: string[];
  /** The search as a code (SKU, barcode, model number), when it looks like one. */
  code: string | null;
  /** The original search, when this plan is a correction of one that found nothing. */
  correctedFrom: string | null;
  /**
   * A stop word that is the last word of a search still being typed — "he"
   * in "wireless he" — read as the start of a word. Set only for suggestions.
   */
  partialPrefix?: string | null;
};

/**
 * The readable part of a search as a tsquery, with a half-typed stop word
 * added as a plain prefix. Null when there is nothing to judge a name by.
 */
function readableQuery(plan: SearchPlan): SQL | null {
  const parts: SQL[] = [];
  if (plan.readableTsquery) {
    parts.push(sql`to_tsquery('english', ${plan.readableTsquery})`);
  }
  if (plan.partialPrefix) {
    parts.push(sql`to_tsquery('simple', ${`${plan.partialPrefix}:*`})`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : sql`(${parts[0]} && ${parts[1]})`;
}

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
 * the full-text document, as a substring of the name — the second is what
 * finds "board" inside "Keyboard" — or through one of the structured terms the
 * knowledge base says the position stands for (D-089). A search that looks
 * like a code also matches a product carrying exactly that code, whatever its
 * words say.
 *
 * The three ways a slot can match are alternatives, never requirements, so
 * adding the knowledge base to an existing search can only ever find more.
 */
export function searchMatch(plan: SearchPlan): SQL {
  const slotConditions = plan.slots
    .map((slot) => {
      const alternatives: SQL[] = [];
      const tsquery = slotTsQuery(slot);
      if (tsquery) {
        alternatives.push(sql`ps.document @@ to_tsquery('english', ${tsquery})`);
      }
      const partial = slotPartialPrefix(slot);
      if (partial) {
        alternatives.push(
          sql`ps.document @@ to_tsquery('simple', ${`${partial}:*`})`,
        );
      }
      for (const pattern of slotTitlePatterns(slot)) {
        alternatives.push(sql`ps.title_norm like ${pattern}`);
      }
      if (slot.terms.length > 0) {
        alternatives.push(sql`ps.terms && ${textArray(slot.terms)}`);
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

  const shortcuts: SQL[] = [];
  if (plan.code) shortcuts.push(sql`ps.codes @> ${textArray([plan.code])}`);
  // The whole search is an approved alias of one product: that product answers
  // it even if not one of its words appears anywhere on the listing.
  if (plan.identityTerms.length > 0) {
    shortcuts.push(sql`ps.terms && ${textArray(plan.identityTerms)}`);
  }

  const match =
    shortcuts.length > 0
      ? sql`(${sql.join([...shortcuts, sql`(${words})`], sql` or `)})`
      : sql`(${words})`;

  // Hidden from search means hidden from search, whatever the words.
  return sql`(${products.searchable} and ${match})`;
}

/**
 * How relevant a listing is, as a tier. Ordering is by tier first, so nothing
 * computed within a tier — popularity, the staff boost, ratings — can lift a
 * weaker match above a stronger one (DECISIONS.md D-027).
 *
 *  10  the whole search is an approved alias of this exact product
 *   9  the search is exactly one of its codes
 *   8  the search is its name (or its name after the brand)
 *   7  the search is its brand, or the brand followed by words from its name
 *   6  the search appears in its name, word for word
 *   5  every readable word appears in its name
 *   4  every readable word appears in its name, brand, model, keywords or shelf
 *   3  … or in its highlights, options and specifications
 *   2  … or anywhere in the listing
 *   1  matched only inside a word of the name, or only through an attribute
 *
 * The two knowledge tiers sit at the top and the bottom on purpose (D-091).
 * An alias naming one product is as exact as a barcode. An attribute matching
 * — "black", "512gb" — is the weakest evidence there is, so a product that
 * answers a search only by carrying the right colour can never climb above one
 * whose name is what was typed.
 *
 * The judgement is made on the *readable* part of the search: a typed quantity
 * is not a word a name is expected to contain, so leaving it in would push
 * every result of "iphone 512gb" into the bottom tier together.
 */
export function relevanceTier(plan: SearchPlan): SQL {
  const q = plan.normalized;
  const full = readableQuery(plan);

  const identity =
    plan.identityTerms.length > 0
      ? sql`when ps.terms && ${textArray(plan.identityTerms)} then 10`
      : sql``;

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
    ${identity}
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
  // How much of the name the search covers, judged on what a name could
  // contain: a typed quantity is not part of that measure.
  const counted = Math.max(
    1,
    plan.readableWords.filter((word) => !isStopword(word)).length,
  );
  const readable = readableQuery(plan);
  const rank = readable
    ? sql`+ 10 * ts_rank_cd(ps.document, ${readable}, 32)`
    : sql``;

  return sql`(
    30.0 * least(1.0, ${counted}::float8 / greatest(ps.title_words, 1))
    + case when (' ' || ps.title_core) like ${`% ${q}`} then 15 else 0 end
    + case when ps.title_norm like ${`${q}%`} then 10 else 0 end
    ${rank}
    + 12 * ${products.searchBoost}
  )`;
}
