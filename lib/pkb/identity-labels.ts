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

/*
 * Which recorded "model numbers" can actually identify a product (D-123).
 *
 * The model and part number fields are free text, and they collect whatever a
 * person had to hand. On a hair colour that was "Shade 10", "10" and "(1N)":
 * a shade, the shade's number and a tone code. None of them names the product
 * a manufacturer sells — dozens of products in any catalogue have a "10" — so
 * none of them may make an identity HIGH_CONFIDENCE or decide that a
 * manufacturer's page is about this product. They are kept exactly as typed;
 * they are only not treated as identity.
 *
 * Two rules, both about the shape of the value and neither about a category:
 *
 *  - a value that names a variant dimension — "Shade 10", "Colour: Black",
 *    "Size M", "Pack of 2" — describes one version of a product, not the
 *    product;
 *  - a code too short to tell products apart — fewer than three letters and
 *    digits, or three digits alone — is not an identifier, however it was
 *    labelled.
 *
 * A real manufacturer code is untouched: "GLO-OC-WL-BLK", "WH-1000XM5",
 * "G502", "HP-900" and "GO-WHITE" all stay model identity.
 */

/** Words that name the dimension one version of a product differs from another in. */
const VARIANT_DIMENSION =
  /^(shade (?:no|number|code)|shade|colou?r (?:no|number|code|name)|colou?r|size|flavou?r|scent|fragrance|pack of|pack|count|capacity|storage|style|finish|tone|hue|variant|version|edition)\b\.?\s*[:#–—-]?\s*(.+)$/i;

export type VariantDescriptor = { dimension: string; value: string };

/**
 * The variant a value describes, when it names one: "Shade 10" is the shade
 * "10", "Colour: Black" the colour "Black". Null for anything else.
 */
export function variantDescriptor(value: string): VariantDescriptor | null {
  const match = VARIANT_DIMENSION.exec(value.normalize("NFKC").trim());
  if (!match) return null;
  const rest = match[2].trim();
  if (!rest || !/[\p{L}\p{N}]/u.test(rest)) return null;
  return { dimension: match[1].toLowerCase().replace(/\s+/g, " "), value: rest };
}

/**
 * Whether a recorded model or part number is strong enough to identify a
 * product and to be compared with what a page declares.
 */
export function isStrongModelKey(value: string): boolean {
  const text = value.normalize("NFKC").trim();
  if (!text || variantDescriptor(text)) return false;
  const alphanumeric = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (alphanumeric.length < 3) return false;
  if (/^\p{N}+$/u.test(alphanumeric) && alphanumeric.length <= 3) return false;
  return true;
}
