import { createHash } from "node:crypto";
import { slugify } from "@/lib/slug";

/**
 * Pure text helpers for SEO Pulse: normalising keywords, removing duplicates,
 * fitting text to a length, building a slug. No database, so every rule is
 * unit-tested directly (tests/seo-pulse.test.ts).
 */

/**
 * The comparable form of a keyword: lowercase, hyphens and underscores read
 * as spaces, other punctuation dropped, spaces collapsed. "Car-Charger" and
 * "car  charger" are one keyword.
 */
export function normalizeKeyword(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}&+.' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key two keywords are duplicates under: normalised, and with a plain
 * trailing "s" dropped from longer words, so "chargers" and "charger" count
 * once in a recommendation list.
 */
export function keywordKey(value: string): string {
  return normalizeKeyword(value)
    .replace(/[.']/g, "")
    .split(" ")
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    )
    .join(" ");
}

/** Keeps the first of each group of duplicates, preserving order. */
export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    kept.push(item);
  }
  return kept;
}

/** Normalised, deduplicated, blank-free terms, at most `max` of them. */
export function cleanTerms(terms: string[], max: number, maxLength = 60): string[] {
  return dedupeBy(
    terms
      .map(normalizeKeyword)
      .filter((term) => term.length >= 2 && term.length <= maxLength),
    keywordKey,
  ).slice(0, max);
}

/** Cuts at a word boundary so text never ends mid-word. */
export function clampText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max + 1);
  const boundary = cut.lastIndexOf(" ");
  const result = (boundary > max * 0.5 ? cut.slice(0, boundary) : cut.slice(0, max))
    .replace(/[\s,;:–—-]+$/, "");
  return result;
}

const SLUG_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "in", "on", "to", "by",
  "new", "best", "buy",
]);

/**
 * An SEO slug: lowercase, hyphenated, ASCII, no filler words, no repeated
 * words, and short — at most 60 characters, cut at a hyphen.
 */
export function suggestSlug(value: string): string {
  const words = slugify(value)
    .split("-")
    .filter((word) => word && !SLUG_STOPWORDS.has(word));
  const unique = dedupeBy(words, (word) => word);
  let slug = "";
  for (const word of unique) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 60) break;
    slug = next;
  }
  return slug || slugify(value).slice(0, 60).replace(/-+$/, "") || "product";
}

/** Plain text from stored description HTML. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON with sorted keys, so equal objects always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Whether every term in `existing` is still in `next`, compared normalised. */
export function isSuperset(next: string[], existing: string[]): boolean {
  const keys = new Set(next.map(normalizeKeyword));
  return existing.every((term) => keys.has(normalizeKeyword(term)));
}

/** Every word of `needle` appears in `haystack`, compared normalised. */
export function containsWords(haystack: string, needle: string): boolean {
  const words = new Set(keywordKey(haystack).split(" "));
  const wanted = keywordKey(needle).split(" ").filter(Boolean);
  return wanted.length > 0 && wanted.every((word) => words.has(word));
}
