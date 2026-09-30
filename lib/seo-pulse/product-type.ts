import { labelKey } from "@/lib/pkb/normalize";
import type { SeoPulseInput } from "./types";

/**
 * What kind of product a listing is, as far as SeoPulse's title fitting
 * needs to know (D-130).
 *
 * Not a classifier. It answers one question — which words of the name say
 * what the product *is* — so a long title can be shortened without losing
 * them. Strongest source first:
 *
 *  1. the product's family in the knowledge base;
 *  2. its category, when the category is specific: the last level of the
 *     path, with no categories under it, that either names a product family
 *     or is named by the listing's title. A category with children is a
 *     grouping ("Electronics", "Pantry"), and so is every level above it;
 *  3. a product type recorded as a fact ("Product type: Olive oil");
 *  4. the title itself, as a last resort (lib/seo-pulse/title-fit.ts): a
 *     phrase of the name the listing's own words repeat, or the name's
 *     closing noun when nothing in the name suggests a descriptive tail.
 *
 * When none of these is sure, the answer is "unknown" — never a guess dressed
 * as a fact. Nothing here knows any brand, category or kind of product.
 */

export type StructuredTypeSource = "family" | "category" | "attribute";
export type ProductTypeSource = StructuredTypeSource | "title";

export type ProductTypeResolution = {
  /** As the title spells it when the title names it; else the structured name. Null when unknown. */
  type: string | null;
  source: ProductTypeSource | null;
};

/** The words of a label, lower-cased, as `labelKey` splits them. */
export function words(text: string): string[] {
  return labelKey(text).split(" ").filter(Boolean);
}

/** A plural's singular, enough to match "Tables" with "Table" and "Batteries" with "Battery". */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  return /[^s]s$/.test(word) ? word.slice(0, -1) : word;
}

/** Whether every content word of `name` is a word of `title`, plurals aside. */
function namedIn(name: string, title: string): boolean {
  const said = new Set(words(title).map(stem));
  const needed = words(name).filter((word) => word.length > 2).map(stem);
  return needed.length > 0 && needed.every((word) => said.has(word));
}

/** "Product type", "Item type", "Item type name", "product_type". */
const PRODUCT_TYPE_LABEL = /^(?:product|item)[\s_-]*type(?:[\s_-]*name)?$/i;

/**
 * The structured names of what the product is, strongest first (sources 1–3
 * above). Empty when only broad groupings are known.
 */
export function structuredProductTypes(input: SeoPulseInput): { name: string; source: StructuredTypeSource }[] {
  const out: { name: string; source: StructuredTypeSource }[] = [];
  const family = input.knowledge?.family?.name?.trim();
  if (family) out.push({ name: family, source: "family" });

  const leaf = input.categoryPath?.at(-1)?.trim();
  const shape = input.categoryShape;
  if (leaf && shape?.hasChildren !== true && (shape?.hasFamily === true || namedIn(leaf, input.title))) {
    out.push({ name: leaf, source: "category" });
  }

  const recorded = [
    ...(input.knowledge?.attributes ?? [])
      .filter((attribute) => attribute.pkbVariantId === null && (attribute.key === "product_type" || PRODUCT_TYPE_LABEL.test(attribute.label)))
      .map((attribute) => attribute.value),
    ...(input.specifications ?? []).filter((row) => PRODUCT_TYPE_LABEL.test(row.label.trim())).map((row) => row.value),
    ...Object.entries(input.details ?? {})
      .filter(([key]) => PRODUCT_TYPE_LABEL.test(key.replace(/([a-z])([A-Z])/g, "$1 $2")))
      .map(([, value]) => String(value ?? "")),
  ];
  for (const value of recorded) {
    const name = value.trim();
    if (name && name.length <= 60) out.push({ name, source: "attribute" });
  }

  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = labelKey(entry.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Detail and fact labels whose value tells one product or variant from another. */
const VARIANT_DETAIL = /^(colou?r|size|shade|scent|flavou?r|capacity|style|pattern|finish|edition|variant)/i;
const IDENTITY_FACT = /^(capacity|storage|volume|net[\s_-]*(?:content|volume|weight|quantity)|generation|concentration|shade|size|pack)/i;

/**
 * The values that tell this product or variant from another: the listing's
 * variant labels and variant details (D-129), and from the knowledge base
 * every variant-level fact and a product-level capacity, volume, size,
 * shade, concentration or generation (D-130). Split into single values.
 */
export function identityValues(input: SeoPulseInput): string[] {
  const details = input.details ?? {};
  return [
    ...Object.entries(details)
      .filter(([key]) => VARIANT_DETAIL.test(key))
      .map(([, value]) => String(value ?? "")),
    ...(input.variants ?? []).map((variant) => variant?.label ?? ""),
    ...(input.knowledge?.attributes ?? [])
      .filter((attribute) => attribute.pkbVariantId !== null || IDENTITY_FACT.test(attribute.key) || IDENTITY_FACT.test(attribute.label))
      .map((attribute) => [attribute.value, attribute.unit && !/\p{L}/u.test(attribute.value) ? attribute.unit : ""].join(" ").trim()),
  ]
    .flatMap((value) => value.split(/\s*[,/|·]\s*/))
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The listing's own words about itself, one entry per line: search keywords,
 * tags, the focus keyword, key features and description — each only when
 * staff wrote it, never SeoPulse's own earlier wording (D-120), which could
 * only repeat an earlier guess.
 */
export function listingVocabulary(input: SeoPulseInput): string {
  const own = input.pulseWritten ?? { description: false, bulletFeatures: false };
  return [
    ...(own.searchKeywords ? [] : (input.searchKeywords ?? [])),
    ...(own.tags ? [] : (input.tags ?? [])),
    own.seoFocusKeyword ? "" : (input.seoFocusKeyword ?? ""),
    ...(own.bulletFeatures ? [] : (input.bulletFeatures ?? [])),
    ...(own.description ? [] : (input.descriptionText ?? "").split(/(?<=[.!?])\s+/)),
  ]
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
