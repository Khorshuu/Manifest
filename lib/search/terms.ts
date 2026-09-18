import { findUnit, isQuantityFailure, parseQuantity, type UnitDimension } from "@/lib/pkb/units";
import { isStopword } from "./normalize";

/**
 * The forms a query and an indexed value must agree on (D-089).
 *
 * The knowledge base normalizes a value once, when it is written: "256GB",
 * "256 GB" and "256 gigabytes" all become 256000000000 bytes in `pkb_facts`.
 * The search index copies those already-canonical values into
 * `product_search.terms`. This file does the same thing to a search, using the
 * same `lib/pkb/units` registry — so the two sides cannot drift apart by one
 * side being changed and the other forgotten. That is the whole point:
 * normalization parity by construction, not by two implementations agreeing
 * for now.
 *
 * `termKey` is the one exception: it has a twin in SQL (`search_term_key`,
 * migration 0036), because the index is built by a trigger. The two are
 * character for character the same rule, and `tests/search-knowledge.test.ts`
 * runs both over the same inputs and fails if they ever differ.
 */

/**
 * The comparison form of a name or a value: lower case, "&" spelled out, every
 * run of anything else one underscore.
 *
 * Accents are deliberately kept. The index keeps them too, and folding on one
 * side only would make "Crème" findable by neither spelling.
 */
export function termKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ /g, "_");
}

/** This exact knowledge product. */
export const productTerm = (pkbProductId: string) => `p:${pkbProductId}`;
/** Its brand. */
export const brandTerm = (key: string) => `b:${key}`;
/** Its family, or one above it. */
export const familyTerm = (key: string) => `f:${key}`;
/** A named attribute with a named value. */
export const attributeTerm = (definitionKey: string, valueKey: string) =>
  `a:${definitionKey}=${valueKey}`;
/** That value, whichever attribute holds it. */
export const valueTerm = (valueKey: string) => `v:${valueKey}`;
/** A quantity in its canonical unit, whichever attribute holds it. */
export const dimensionTerm = (dimension: string, canonical: string) =>
  `u:${dimension}=${canonical}`;

/**
 * A quantity written in a search, with the words it occupies.
 *
 * `text` is exactly what was typed, so the words it covers can be found again
 * in the tokenised search and replaced by one slot.
 */
export type QuantityInQuery = {
  text: string;
  dimension: UnitDimension;
  /** The canonical value as decimal text — the same form the index stores. */
  canonical: string;
  term: string;
};

/**
 * Every dimension a written unit could belong to. A unit names exactly one
 * dimension in the registry, so this is a lookup rather than a search.
 */
function dimensionOf(unitText: string): UnitDimension | null {
  return findUnit(unitText)?.dimension ?? null;
}

/** A number followed by letters: "512gb", "512 GB", "6.1 inch", "20 kHz". */
const QUANTITY_IN_TEXT = /(\d+(?:\.\d+)?)(\s*)([\p{L}]+)/gu;

/**
 * The quantities a search contains.
 *
 * Read from the search as typed rather than from its words, because splitting
 * on punctuation first would turn "6.1 inch" into "6", "1", "inch" and lose
 * the number.
 *
 * A unit written against the number ("512gb") is always taken. A unit written
 * apart from it is taken only when it is at least two letters and not an
 * English stop word — otherwise "2 in 1 case" would be read as a length of
 * 50.8 mm and quietly widen the search to every product that measures it.
 */
export function quantitiesIn(query: string): QuantityInQuery[] {
  const found: QuantityInQuery[] = [];
  QUANTITY_IN_TEXT.lastIndex = 0;

  for (const match of query.matchAll(QUANTITY_IN_TEXT)) {
    const [text, number, gap, unitText] = match;
    const attached = gap.length === 0;
    if (!attached && (unitText.length < 2 || isStopword(unitText.toLowerCase()))) {
      continue;
    }

    const dimension = dimensionOf(unitText);
    if (!dimension) continue;

    const parsed = parseQuantity(`${number} ${unitText}`, dimension);
    if (isQuantityFailure(parsed)) continue;

    found.push({
      text,
      dimension,
      canonical: parsed.value,
      term: dimensionTerm(dimension, parsed.value),
    });
  }

  return found;
}
