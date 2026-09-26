import type { CandidateKind, ExtractionCandidate } from "@/lib/providers/extraction/types";
import type { ExtractedPair, Extraction } from "./extract";
import { isIdentityLabel } from "./identity-labels";
import { cleanText, labelKey } from "./normalize";

/**
 * Deterministic checks around intelligent extraction (D-123).
 *
 * A provider may only point at what a document says. Every candidate it
 * returns is checked here against the text Manifest itself retrieved, and a
 * candidate that fails any check is dropped — not corrected, not softened,
 * and never stored as evidence:
 *
 *  1. the excerpt must be the document's own text (compared after folding
 *     case, whitespace, quote and dash styles and trademark signs — never
 *     after rewording);
 *  2. every number in the value must be a number in that excerpt, so no
 *     figure, percentage, shade number or capacity can be introduced;
 *  3. every significant word of the value must be in that excerpt, so no
 *     ingredient, compatibility, certification or included item can be;
 *  4. a yes/no value needs the label's own words in the excerpt;
 *  5. identity, marketing and commercial statements (price, stock, delivery)
 *     are never product facts;
 *  6. on a page selling several versions, a version's fact is kept only when
 *     it names this product's version.
 *
 * What survives becomes an `ai_assisted` pair whose excerpt is the document's
 * original text at the matched position. The provider's wording is kept only
 * as the label a person is asked about; the evidence is always the page.
 */

export type GroundingRejection =
  | "identity"
  | "marketing"
  | "commercial"
  | "excerpt_not_in_source"
  | "unsupported_number"
  | "unsupported_value"
  | "unsupported_label"
  | "variant_unresolved"
  | "other_variant"
  | "empty";

export type GroundedCandidate = {
  pair: ExtractedPair;
  kind: CandidateKind;
  meaning: string | null;
};

export type GroundingContext = {
  /** The document's visible text as stored. */
  text: string;
  /** Set when the document sells several versions. */
  versions: {
    /** This product's version's distinguishing words, or null when it could not be told. */
    ours: string[] | null;
  } | null;
};

// ------------------------------------------------------------ folding text

/**
 * Folds text for comparison and remembers where each folded character came
 * from, so a match can be cut out of the original.
 */
function fold(text: string): { folded: string; start: number[]; end: number[] } {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  let lastSpace = true;
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    const width = char.length;
    let out = char
      .replace(/[™®©℠*†‡]/g, "")
      .replace(/[‘’‚‛′`]/g, "'")
      .replace(/[“”„″]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .normalize("NFKC")
      .toLowerCase();
    if (/^\s+$/.test(out)) out = " ";
    for (const piece of out) {
      if (piece === " ") {
        if (lastSpace) continue;
        lastSpace = true;
      } else {
        lastSpace = false;
      }
      folded += piece;
      start.push(index);
      end.push(index + width);
    }
    index += width;
  }
  return { folded, start, end };
}

function foldPlain(text: string): string {
  return fold(text).folded.trim();
}

const EDGE_PUNCTUATION = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g;

/** Where the excerpt is in the document, as the document's own text; null when it is not there. */
export function locateExcerpt(documentText: string, excerpt: string): string | null {
  const document = fold(documentText);
  const cut = (from: number, to: number) => documentText.slice(document.start[from], document.end[to - 1]);
  const wanted = foldPlain(excerpt).replace(EDGE_PUNCTUATION, "");
  if (wanted.length < 3) return null;

  const at = document.folded.indexOf(wanted);
  if (at >= 0) return cut(at, at + wanted.length);

  // "…" or "...": each quoted piece must be there, in order.
  const pieces = wanted
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((piece) => piece.replace(EDGE_PUNCTUATION, ""))
    .filter(Boolean);
  if (pieces.length < 2 || pieces.some((piece) => piece.length < 12)) return null;
  let from = -1;
  let cursor = 0;
  let last = -1;
  for (const piece of pieces) {
    const found = document.folded.indexOf(piece, cursor);
    if (found < 0) return null;
    if (from < 0) from = found;
    cursor = found + piece.length;
    last = cursor;
  }
  // A quote stitched from passages far apart is not one statement.
  if (last - from > 1_500) return null;
  return cut(from, last);
}

// ---------------------------------------------------------------- support

/** Numbers as written: "1,000" is 1000, "9X" is 9, "2.5" stays 2.5. */
export function numbersIn(text: string): string[] {
  return [...foldPlain(text).matchAll(/\d+(?:[.,]\d+)*/g)].map((match) => {
    const raw = match[0];
    const grouped = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", ".");
    return grouped.replace(/^0+(?=\d)/, "");
  });
}

const STOPWORDS = new Set([
  "the", "and", "with", "for", "from", "that", "this", "your", "you", "are", "was", "has", "have", "its",
  "per", "all", "any", "each", "into", "onto", "our", "not", "but", "can", "will", "yes", "via", "than",
]);

/** Unit spellings that are the same unit: a value may say "25 min" where the page says "25 minutes". */
const UNIT_FAMILIES = [
  ["min", "mins", "minute", "minutes"],
  ["hr", "hrs", "hour", "hours", "h"],
  ["sec", "secs", "second", "seconds", "s"],
  ["g", "gram", "grams", "gr"],
  ["kg", "kilogram", "kilograms"],
  ["mg", "milligram", "milligrams"],
  ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  ["l", "liter", "liters", "litre", "litres"],
  ["oz", "ounce", "ounces"],
  ["fl", "fluid"],
  ["lb", "lbs", "pound", "pounds"],
  ["in", "inch", "inches"],
  ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
  ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
  ["pct", "percent", "%"],
  ["wk", "wks", "week", "weeks"],
];
const UNIT_OF = new Map(UNIT_FAMILIES.flatMap((family, index) => family.map((word) => [word, index] as const)));

function words(text: string): string[] {
  return labelKey(text.replace(/[™®©℠]/g, " ").replace(/%/g, " percent "))
    .split(" ")
    .filter(Boolean);
}

function significant(text: string): string[] {
  return words(text).filter((word) => !/^\d/.test(word) && (word.length >= 3 || UNIT_OF.has(word)) && !STOPWORDS.has(word));
}

/** Whether a word of the value is stated by the excerpt: the same word, a plural, or the same unit. */
function stated(word: string, excerptWords: Set<string>, excerptList: string[]): boolean {
  if (excerptWords.has(word)) return true;
  const unit = UNIT_OF.get(word);
  if (unit !== undefined && excerptList.some((other) => UNIT_OF.get(other) === unit)) return true;
  return excerptList.some((other) => {
    const [short, long] = word.length <= other.length ? [word, other] : [other, word];
    return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
  });
}

const BOOLEAN_VALUE = /^(yes|no|true|false|included|not included|none|present|absent)$/i;
/** Offer terms: never a fact about the product (invariant I-8). */
const COMMERCIAL =
  /(\$\s?\d|\b(?:price|prices|priced|usd|msrp|shipping|ships free|free delivery|in stock|out of stock|sold out|on sale|discount|coupon|promo(?:tion)?|free returns?|subscribe and save|add to cart|customer reviews?)\b)/i;

/** One candidate checked against the document. */
export function groundCandidate(
  candidate: ExtractionCandidate,
  context: GroundingContext,
): { ok: true; grounded: GroundedCandidate } | { ok: false; reason: GroundingRejection } {
  const label = cleanText(candidate.label);
  const value = cleanText(candidate.value);
  if (!label || !value) return { ok: false, reason: "empty" };
  if (candidate.kind === "identity" || isIdentityLabel(label)) return { ok: false, reason: "identity" };
  if (candidate.kind === "marketing") return { ok: false, reason: "marketing" };
  if (COMMERCIAL.test(label) || COMMERCIAL.test(value)) return { ok: false, reason: "commercial" };

  const excerpt = locateExcerpt(context.text, candidate.excerpt);
  if (!excerpt) return { ok: false, reason: "excerpt_not_in_source" };

  const excerptNumbers = new Set(numbersIn(excerpt));
  if (numbersIn(value).some((number) => !excerptNumbers.has(number))) return { ok: false, reason: "unsupported_number" };
  if (numbersIn(label).some((number) => !excerptNumbers.has(number))) return { ok: false, reason: "unsupported_number" };

  const excerptList = words(excerpt);
  const excerptWords = new Set(excerptList);
  const foldedExcerpt = foldPlain(excerpt);
  const foldedValue = foldPlain(value).replace(EDGE_PUNCTUATION, "");
  const verbatim = foldedValue.length > 0 && foldedExcerpt.includes(foldedValue);
  if (!verbatim && significant(value).some((word) => !stated(word, excerptWords, excerptList))) {
    return { ok: false, reason: "unsupported_value" };
  }
  if (BOOLEAN_VALUE.test(value) || significant(value).length === 0) {
    const labelWords = significant(label);
    if (labelWords.length === 0 || labelWords.some((word) => !stated(word, excerptWords, excerptList))) {
      return { ok: false, reason: "unsupported_label" };
    }
  }

  let scope: ExtractedPair["scope"];
  if (candidate.kind === "variant_fact" && context.versions) {
    const ours = context.versions.ours;
    if (!ours || ours.length === 0) return { ok: false, reason: "variant_unresolved" };
    const oursWords = ours.flatMap((entry) => significant(entry).concat(numbersIn(entry)));
    if (oursWords.length === 0 || oursWords.some((word) => !stated(word, excerptWords, excerptList) && !excerptNumbers.has(word))) {
      return { ok: false, reason: "other_variant" };
    }
    scope = "variant";
  }

  // The value as the page writes it, when the page writes it verbatim.
  const sourceValue = verbatim ? locateExcerpt(excerpt, value) ?? value : value;
  const section = candidate.section ? cleanText(candidate.section).slice(0, 80) : null;
  return {
    ok: true,
    grounded: {
      kind: candidate.kind,
      meaning: candidate.meaning ? cleanText(candidate.meaning).slice(0, 80) : null,
      pair: {
        label: candidate.kind === "box_content" ? "What's in the box" : label.slice(0, 80),
        value: cleanText(sourceValue).slice(0, 400),
        unit: candidate.unit ? cleanText(candidate.unit).slice(0, 20) || null : null,
        method: "ai_assisted",
        locator: `AI-assisted reading${section ? ` · ${section}` : ""} · ${candidate.kind.replace(/_/g, " ")}`.slice(0, 200),
        excerpt: cleanText(excerpt).slice(0, 1_500),
        ...(scope ? { scope } : {}),
        suggestion: { kind: candidate.kind, meaning: candidate.meaning ? cleanText(candidate.meaning).slice(0, 80) : null },
      },
    },
  };
}

export type GroundingReport = {
  grounded: GroundedCandidate[];
  rejected: { candidate: ExtractionCandidate; reason: GroundingRejection }[];
};

/** Every candidate checked; the grounded ones deduplicated against each other. */
export function groundCandidates(candidates: ExtractionCandidate[], context: GroundingContext): GroundingReport {
  const report: GroundingReport = { grounded: [], rejected: [] };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const result = groundCandidate(candidate, context);
    if (!result.ok) {
      report.rejected.push({ candidate, reason: result.reason });
      continue;
    }
    const key = `${labelKey(result.grounded.pair.label)}|${labelKey(result.grounded.pair.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.grounded.push(result.grounded);
  }
  return report;
}

// ------------------------------------------------------------ usefulness

/** Pairs that read as facts, at or above which a document needs no further reading. */
export const USEFUL_PAIRS = 6;
/** Below this much visible text there is nothing for a reader to find. */
const MIN_TEXT_FOR_ASSISTANCE = 300;

/**
 * How much of a document the deterministic readers turned into usable facts:
 * pairs that are not identity and whose value is a value, not a paragraph.
 * A page of specification rows scores high and is never sent anywhere; a
 * page that says everything in sentences scores low.
 */
export function extractionUsefulness(extraction: Extraction): { useful: number; needsAssistance: boolean } {
  const useful = extraction.pairs.filter((pair) => {
    if (isIdentityLabel(pair.label)) return false;
    const value = cleanText(pair.value);
    return value.length <= 120 && value.split(" ").length <= 16 && !/[.!?]\s+\p{Lu}/u.test(value);
  }).length;
  return { useful, needsAssistance: useful < USEFUL_PAIRS && extraction.text.length >= MIN_TEXT_FOR_ASSISTANCE };
}

/**
 * Adds grounded pairs to what the deterministic readers found, without
 * repeating a statement they already made. The deterministic pairs stay
 * first and are never replaced.
 */
export function mergeGroundedPairs(base: ExtractedPair[], grounded: GroundedCandidate[]): ExtractedPair[] {
  const labels = new Set(base.map((pair) => labelKey(pair.label)));
  const values = new Set(base.map((pair) => labelKey(pair.value)));
  const merged = [...base];
  for (const { pair } of grounded) {
    if (labels.has(labelKey(pair.label)) && pair.label !== "What's in the box") continue;
    if (values.has(labelKey(pair.value))) continue;
    merged.push(pair);
  }
  return merged;
}
