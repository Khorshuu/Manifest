import { labelKey } from "./normalize";

/**
 * The one list of labels that name a product rather than describe it.
 *
 * "Brand: Glorious", "Model number: GO-WHITE", "MPN: GO-WHITE" and "GTIN-12:
 * 840408304115" say which product this is. They are what identity matching
 * compares, and they are worth showing a shopper under an Identifiers heading,
 * but none of them tells a shopper anything about the product — so none of
 * them is a key feature, and none of them makes a product "described".
 *
 * There used to be two copies of this list, one deciding what the extractor
 * treats as identity and one deciding what knowledge sufficiency ignores, and
 * they had drifted: one knew "part number" and "MPN", the other did not, and
 * a product whose only researched facts were its part number and MPN was
 * shown those as key features. Every place that asks "is this label identity?"
 * now asks here.
 *
 * Compared through `labelKey`, so "Model No.", "model no" and "MODEL NO" are
 * one label, and "GTIN-12" is "gtin 12".
 */

export type IdentityLabelKind = "brand" | "manufacturer" | "name" | "model" | "mpn" | "gtin" | "sku" | "asin";

const LABELS: [string, IdentityLabelKind][] = [
  ["brand", "brand"],
  ["brand name", "brand"],
  ["manufacturer", "manufacturer"],
  ["manufacturer name", "manufacturer"],
  ["model name", "name"],
  ["model", "model"],
  ["model number", "model"],
  ["model no", "model"],
  ["model code", "model"],
  ["item model number", "model"],
  ["mpn", "mpn"],
  ["manufacturer part number", "mpn"],
  ["part number", "mpn"],
  ["part no", "mpn"],
  ["gtin", "gtin"],
  ["gtin8", "gtin"],
  ["gtin 8", "gtin"],
  ["gtin12", "gtin"],
  ["gtin 12", "gtin"],
  ["gtin13", "gtin"],
  ["gtin 13", "gtin"],
  ["gtin14", "gtin"],
  ["gtin 14", "gtin"],
  ["upc", "gtin"],
  ["upc code", "gtin"],
  ["ean", "gtin"],
  ["ean code", "gtin"],
  ["jan", "gtin"],
  ["isbn", "gtin"],
  ["barcode", "gtin"],
  ["sku", "sku"],
  ["asin", "asin"],
];

export const IDENTITY_LABEL_KINDS: ReadonlyMap<string, IdentityLabelKind> = new Map(
  LABELS.map(([label, kind]) => [labelKey(label), kind]),
);

/** What kind of identifier a label names, or null when it describes the product. */
export function identityLabelKind(label: string): IdentityLabelKind | null {
  return IDENTITY_LABEL_KINDS.get(labelKey(label)) ?? null;
}

export function isIdentityLabel(label: string): boolean {
  return identityLabelKind(label) !== null;
}

/**
 * Whether a one-line feature only restates an identifier: "Part number:
 * GO-WHITE", "MPN — GO-WHITE". A line that merely mentions a model number in
 * the middle of a sentence is a feature and is left alone.
 */
export function isIdentityLine(line: string): boolean {
  const match = /^\s*([^:–—-]{1,40}?)\s*[:–—-]\s*\S/.exec(line);
  return match !== null && isIdentityLabel(match[1]);
}
