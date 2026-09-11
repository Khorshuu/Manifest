/**
 * Turning what someone typed into something a query can use.
 *
 * Pure functions only — no database — so the rules are unit-testable and the
 * suggestions, the results page and the analytics all read a search the same
 * way. The database has its own `search_normalize` (migration 0014) and the
 * two agree for everything a keyboard produces here: lowercase, letters and
 * digits kept, every run of anything else one space.
 *
 * Nothing that reaches a tsquery comes from here unescaped. A word is letters
 * and digits by construction, so none of tsquery's operators (`&`, `|`, `!`,
 * `<->`, `:*`, parentheses) can arrive from a search box.
 */

/** Longer than any real search; long enough that a pasted title still works. */
export const MAX_QUERY_LENGTH = 100;

/** No more than this many words are taken from one search. */
export const MAX_TERMS = 8;

/**
 * The English stop words `to_tsvector('english')` throws away. A slot made of
 * nothing but these would reach Postgres as an empty query, which matches
 * nothing and prints a notice — so they are dropped here first.
 */
const STOPWORDS = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your",
  "yours", "yourself", "yourselves", "he", "him", "his", "himself", "she",
  "her", "hers", "herself", "it", "its", "itself", "they", "them", "their",
  "theirs", "themselves", "what", "which", "who", "whom", "this", "that",
  "these", "those", "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an",
  "the", "and", "but", "if", "or", "because", "as", "until", "while", "of",
  "at", "by", "for", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "to", "from", "up", "down",
  "in", "out", "on", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "any",
  "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "s", "t", "can",
  "will", "just", "don", "should", "now",
]);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}

/**
 * The search as it will be shown back and logged: one line, no control
 * characters, and cut to a length nothing legitimate exceeds.
 */
export function cleanQuery(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";

  // Control characters become spaces. Done by code point rather than with a
  // regular expression, which lint rightly refuses to let contain them.
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");

  return printable.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH).trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** The words of a search, at most `MAX_TERMS` of them. */
export function queryWords(text: string): string[] {
  return words(text).slice(0, MAX_TERMS);
}

/**
 * The words of a search in the case they were typed, aligned one to one with
 * `queryWords`. Used to show a corrected search back without lowercasing the
 * words the shopper got right.
 */
export function queryTokens(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

/** The whole search, normalised the way `search_normalize` does it. */
export function normalizeText(text: string): string {
  return words(text).join(" ");
}

/** A code with its punctuation removed — "ABC-123" and "abc123" are one SKU. */
export function codeKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The shape of a SKU, a model number or a barcode: short, and carrying a
 * digit. Checking it costs one indexed lookup, so a false positive
 * ("iphone15") is harmless — it simply finds no code and searches as words.
 */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (!/\d/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 3) return false;
  return codeKey(trimmed).length >= 3;
}

/**
 * The URL key of a filterable attribute. Mirrors `search_slug` in the
 * migration, character for character: both lowercase and turn every run of
 * anything but a-z and 0-9 into one hyphen.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The old query builder, kept because it states the base rule plainly: every
 * word a prefix, every word required.
 */
export function toTsQuery(term: string): string | null {
  const list = queryWords(term);
  if (list.length === 0) return null;
  return list.map((word) => `${word}:*`).join(" & ");
}

/**
 * One position in a search. Usually a single word; a phrase when a synonym
 * matched more than one word ("cell phone"). Its alternatives are the words
 * as typed plus whatever the synonyms add, and any of them will do.
 */
export type Slot = {
  typed: string[];
  alternatives: string[][];
};

const prefix = (word: string) => `${word}:*`;

/**
 * A slot as tsquery text, or null when every alternative is stop words.
 *
 * A multi-word alternative is ANDed rather than phrase-matched: the document
 * has stop words removed, so "case for iphone" is not three adjacent
 * positions, and a phrase operator would quietly miss it.
 */
export function slotTsQuery(slot: Slot): string | null {
  const parts = slot.alternatives
    .map((alternative) => alternative.filter((word) => !isStopword(word)))
    .filter((alternative) => alternative.length > 0)
    .map((alternative) =>
      alternative.length === 1
        ? prefix(alternative[0])
        : `(${alternative.map(prefix).join(" & ")})`,
    );

  const unique = [...new Set(parts)];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : `(${unique.join(" | ")})`;
}

/** Substring patterns a slot's single-word alternatives match inside a name. */
export function slotTitlePatterns(slot: Slot): string[] {
  return [
    ...new Set(
      slot.alternatives
        .filter((alternative) => alternative.length === 1)
        .map((alternative) => alternative[0])
        // Two letters inside a word matches half the catalogue.
        .filter((word) => word.length >= 3 && !isStopword(word))
        .map((word) => `%${word}%`),
    ),
  ];
}

/** Every slot, ANDed. Null when nothing usable is left. */
export function combinedTsQuery(slots: Slot[]): string | null {
  const parts = slots
    .map(slotTsQuery)
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" & ");
}

/**
 * Something that looks like an email address or a phone number. A search like
 * that is not logged anywhere — not in analytics and not in anyone's history.
 */
export function looksPersonal(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || /\d[\d\s-]{6,}\d/.test(text);
}
