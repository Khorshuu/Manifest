/**
 * Short generated SKUs (D-128).
 *
 * A generated variant SKU used to be the product's slug, uppercased — for a
 * long title, most of the title: "PNY-GEFORCE-RTX-5070-ARGB-EPIC-X-RGB-OC-
 * TRIPLE-FAN-12GB-GDDR7-GRAPHICS-CARD", longer than the 64 characters a SKU
 * may be. A SKU is a stock-keeping code staff read and type, not a title.
 *
 * The code is built from what identifies the product, in order:
 *
 *   BRAND - MODEL - VARIANT…
 *
 *  - BRAND: the brand's first word (two short ones together), at most 8.
 *  - MODEL: the model or part number when the listing has one, compacted; or
 *    else a short token from the title — the first word carrying a number,
 *    with the word before it ("RTX 5070" → RTX5070), or the first two words
 *    that are not the brand or filler.
 *  - VARIANT: each distinguishing value ("Black", "12 GB" → BLACK, 12GB), so
 *    two variants of one product never share a base.
 *
 * Nothing here knows any brand or kind of product. Everything is ASCII
 * letters and digits joined by "-", uppercase, like the SKUs staff already
 * type. The result is deterministic for the same input; a collision gets a
 * short numeric suffix (-2, -3 …). It is always at most 64 characters, and
 * usually well under 40.
 *
 * This is Manifest's own stock code. The manufacturer's part number, model
 * number and GTIN are identifiers recorded separately; a SKU may borrow the
 * model's characters for readability, but it is never one of them.
 *
 * Only new variants are given a generated SKU. A SKU staff typed or changed
 * is never regenerated.
 */

export const SKU_MAX_LENGTH = 64;
const PREFERRED_LENGTH = 40;

export type SkuIdentity = {
  brand?: string | null;
  /** The model number or manufacturer part number, when the listing has one. */
  model?: string | null;
  title?: string | null;
};

const FILLER = new Set([
  "THE", "AND", "WITH", "FOR", "OF", "A", "AN", "IN", "ON", "BY", "TO", "NEW", "EDITION", "VERSION", "SERIES",
  "PACK", "SET", "KIT", "FROM", "PLUS",
]);

/** Letters and digits only, ASCII, uppercase: "Épée 2" → "EPEE2". */
function ascii(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toUpperCase())
    .filter(Boolean);
}

function brandToken(brand: string | null | undefined): string {
  const parts = words(brand ?? "");
  if (parts.length === 0) return "";
  const first = parts[0].length < 3 && parts[1] ? parts[0] + parts[1] : parts[0];
  return first.slice(0, 8);
}

function productToken(identity: SkuIdentity, brand: string): string {
  const model = ascii(identity.model ?? "");
  if (model.length >= 2) {
    const withoutBrand = brand && model.startsWith(brand) && model.length > brand.length + 1 ? model.slice(brand.length) : model;
    return withoutBrand.slice(0, 14);
  }
  const brandWords = new Set(words(identity.brand ?? ""));
  const titleWords = words(identity.title ?? "").filter((word) => !brandWords.has(word) && !FILLER.has(word));
  const numbered = titleWords.findIndex((word) => /\d/.test(word));
  if (numbered >= 0) {
    const before = titleWords[numbered - 1];
    const joined = before && /^[A-Z]{1,6}$/.test(before) ? before + titleWords[numbered] : titleWords[numbered];
    return joined.slice(0, 12);
  }
  return titleWords
    .slice(0, 2)
    .map((word) => word.slice(0, 6))
    .join("");
}

/**
 * The SKU a new variant would be given, before collisions are considered.
 * Always 1–64 characters of A–Z, 0–9 and "-".
 */
export function skuBase(identity: SkuIdentity, variantValues: string[] = []): string {
  const brand = brandToken(identity.brand);
  const product = productToken(identity, brand);
  const head = [brand, product].filter(Boolean);
  const inHead = head.join("");
  const variants = variantValues
    .map((value) => ascii(value).slice(0, 8))
    .filter((token) => token && !inHead.includes(token));

  let parts = [...head, ...variants];
  if (parts.length === 0) parts = ["ITEM"];
  let sku = parts.join("-");
  // Shorten the longest part until it reads comfortably; never below 3.
  while (sku.length > PREFERRED_LENGTH) {
    const longest = parts.reduce((best, part, index) => (part.length > parts[best].length ? index : best), 0);
    if (parts[longest].length <= 3) break;
    parts = parts.map((part, index) => (index === longest ? part.slice(0, part.length - 1) : part));
    sku = parts.join("-");
  }
  return sku.slice(0, SKU_MAX_LENGTH).replace(/-+$/, "") || "ITEM";
}

/**
 * The base itself when it is free, otherwise the base with the first free
 * short suffix. The base is shortened as needed so the result stays within
 * 64 characters.
 */
export function uniqueSku(base: string, taken: ReadonlySet<string>): string {
  const clean = base.slice(0, SKU_MAX_LENGTH);
  if (!taken.has(clean)) return clean;
  for (let attempt = 2; attempt < 100_000; attempt++) {
    const suffix = `-${attempt}`;
    const candidate = `${clean.slice(0, SKU_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused SKU based on "${base}".`);
}
