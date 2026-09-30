import { labelKey } from "@/lib/pkb/normalize";
import { variantDescriptor } from "@/lib/pkb/identity-labels";
import { EVALUATIVE_PATTERN } from "./claim-words";
import type { SeoPulseInput } from "./types";

/**
 * Fitting a product name into an SEO title (D-129).
 *
 * A long name used to be cut at a character count, which could end a title
 * on half a phrase: "… 12GB GDDR7 Graphics". Here the name is read as units
 * — a word, a number with its unit ("12GB", "50 ml"), a model number with
 * the word it belongs to ("RTX 5070"), a bracketed aside — and each unit is
 * ranked by what it does for the product's identity. The least useful units
 * are taken out first, whole, until the title fits:
 *
 *   0  a repeated word, praise ("Premium", "Ultimate"), "New"
 *   1  an aside: a bracket, or a phrase after a comma, bar or dash
 *   2  a descriptive phrase after "for"/"with" ("for Normal/Dry Skin")
 *   2  a descriptive word the established facts already state ("Triple fan")
 *   3  any other descriptive word ("Longwear")
 *   4  a descriptive word inside the recorded model name
 *   5  a technical code the model name does not contain ("GDDR7")
 *   6  a quantity ("12GB", "50 ml") — often what tells one variant from another
 *
 * Never taken out: the brand, the first word, a code in the model name
 * ("EPIC-X", "WH-1000XM5"), the product-type noun at the end of the name
 * ("Graphics Card", "Eau de Parfum"), a word the family or category names,
 * and a variant's value (colour, size, shade). Nothing here knows any brand
 * or kind of product.
 *
 * The title aims for 49 characters so the page title, with " · Manifest",
 * stays within 60; when the protected identity alone is longer, it may use up
 * to 60 (the readiness policy, lib/seo/readiness.ts) rather than lose part of
 * the identity. Only a name whose protected identity is longer than 60 is cut
 * — at a unit boundary, never inside a word or between a number and its unit.
 */

/** Readiness policy (lib/seo/readiness.ts): an SEO title of 30–60 characters. */
export const SEO_TITLE_MAX = 60;
/** The layout appends the site's name to every page title (app/layout.tsx). */
export const SITE_TITLE_SUFFIX = " · Manifest";
/** What a title aims for, so the page title with the site's name fits in 60. */
export const SEO_TITLE_TARGET = SEO_TITLE_MAX - SITE_TITLE_SUFFIX.length;
/** " · Manifest", " | Manifest", " - Manifest" at the end of a title. */
export const SITE_NAME_SUFFIX = /\s*[·|\-–—:]\s*manifest\s*$/i;

export type TitleIdentity = {
  brand: string | null;
  /** The recorded model name and number. */
  model: string | null;
  /** Names of the kind of product: its family and its category. */
  productType: string[];
  /** Values one variant differs from another in: colour, size, shade … */
  variants: string[];
  /** Established fact values, lower-cased. */
  factText: string;
};

const VARIANT_DETAIL = /^(colou?r|size|shade|scent|flavou?r|capacity|style|pattern|finish|edition|variant)/i;

export function titleIdentity(input: SeoPulseInput): TitleIdentity {
  const details = input.details ?? {};
  return {
    brand: (input.knowledge?.brand ?? input.brand ?? "").trim() || null,
    model: [input.knowledge?.modelName ?? details.modelName ?? "", details.modelNumber ?? ""].join(" ").trim() || null,
    productType: [input.knowledge?.family?.name ?? "", ...(input.categoryPath ?? [])].filter(Boolean),
    variants: [
      ...Object.entries(details)
        .filter(([key]) => VARIANT_DETAIL.test(key))
        .map(([, value]) => String(value ?? "")),
      ...(input.variants ?? []).map((variant) => variant?.label ?? ""),
    ].flatMap((value) => value.split(/\s*[,/|·]\s*/)).filter(Boolean),
    factText: [
      ...(input.knowledge?.attributes ?? []).map((attribute) => attribute.value ?? ""),
      ...(input.specifications ?? []).map((row) => row.value),
    ]
      .join(" \n ")
      .toLowerCase(),
  };
}

type Unit = {
  text: string;
  kind: "word" | "separator" | "aside";
  /** 0 for the name itself; 1 and up after each comma, bar or dash. */
  segment: number;
  /** Units removed together share a group. */
  group: number;
  priority: number;
};

const UNIT_WORD = "(?:[kmgt]b|[kmg]?hz|mah|wh|kw|w|v|mm|cm|in|inch(?:es)?|ft|ml|cl|l|fl\\.? ?oz|oz|g|kg|mg|lbs?|ct|pcs?|pack|count|k|%|x|pieces?|sheets?|capsules?|tablets?)";
const UNIT_TOKEN = new RegExp(`^${UNIT_WORD}$`, "i");
const QUANTITY = new RegExp(`^\\d+(?:[.,]\\d+)*\\s?${UNIT_WORD}$`, "i");
const NUMBER = /^\d+(?:[.,]\d+)*$/;
const SEPARATOR = /^(?:,|\||[–—]|-|\/)$/;
/** Words that start a descriptive phrase after the name ("… Makeup for Dry Skin"). */
const PHRASE_START = /^(?:for|with|featuring|including|incl\.?)$/i;
/** Words that join; left dangling at an end, they go. */
const JOINER = /^(?:and|or|&|\+|with|for|of|in|by|featuring|including|incl\.?)$/i;
const PROMOTIONAL = /^(?:new|latest|hot|sale|deal|bestseller|best-selling)$/i;
const CODED = (text: string) => /\p{N}/u.test(text) || /\p{Lu}{2,}/u.test(text) || /\p{Ll}\p{Lu}/u.test(text) || /^\p{Lu}$/u.test(text) || /-[\p{Lu}\p{N}]/u.test(text);

function words(text: string): string[] {
  return labelKey(text).split(" ").filter(Boolean);
}

/** A plural's singular, enough to match "Tables" with "Table" and "Batteries" with "Battery". */
function stem(word: string): string {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  return /[^s]s$/.test(word) ? word.slice(0, -1) : word;
}

function tokenize(title: string): Unit[] {
  const raw = title.match(/\([^)]*\)?|\[[^\]]*\]?|,|\||[–—]|(?<=^|\s)[-/](?=\s|$)|[^\s,|()[\]]+/g) ?? [];
  const units: Unit[] = [];
  let segment = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (SEPARATOR.test(token)) {
      segment += 1;
      units.push({ text: token, kind: "separator", segment, group: units.length, priority: 0 });
      continue;
    }
    if (/^[([]/.test(token)) {
      units.push({ text: token, kind: "aside", segment, group: units.length, priority: 1 });
      continue;
    }
    const previous = units.at(-1);
    if (NUMBER.test(token)) {
      const next = raw[index + 1];
      if (next && UNIT_TOKEN.test(next)) {
        // "50 ml": a number and its unit are one unit.
        units.push({ text: `${token} ${next}`, kind: "word", segment, group: units.length, priority: 0 });
        index += 1;
        continue;
      }
      const beforeOf = units.at(-2);
      if (previous?.kind === "word" && /^of$/i.test(previous.text) && beforeOf?.kind === "word" && !/\p{N}/u.test(beforeOf.text)) {
        // "Pack of 2", "Set of 3": one unit.
        units.pop();
        beforeOf.text = `${beforeOf.text} of ${token}`;
        continue;
      }
      if (previous?.kind === "word" && !QUANTITY.test(previous.text) && !JOINER.test(previous.text)) {
        // "RTX 5070", "Liberty 4", "PCIe 5.0": a bare number belongs to the word before it.
        previous.text = `${previous.text} ${token}`;
        continue;
      }
    }
    units.push({ text: token, kind: "word", segment, group: units.length, priority: 0 });
  }
  return units;
}

/** Ranks every unit; `Infinity` is never removed by the semantic step. */
function rank(units: Unit[], identity: TitleIdentity): void {
  const brandWords = new Set(words(identity.brand ?? ""));
  const modelWords = new Set(words(identity.model ?? ""));
  const typeStems = new Set(identity.productType.flatMap(words).map(stem));
  const variantKeys = new Set(identity.variants.map((value) => labelKey(value)).filter(Boolean));
  const variantWords = new Set(identity.variants.flatMap(words));
  const factWords = new Set(words(identity.factText).filter((word) => word.length >= 3));
  const inside = (text: string, set: Set<string>) => words(text).length > 0 && words(text).every((word) => set.has(word));
  const lastSegment = Math.max(...units.map((unit) => unit.segment));

  // The name itself is segment 0; a phrase after "for"/"with" in it is one removable group.
  const core = units.filter((unit) => unit.segment === 0 && unit.kind === "word");
  const phraseAt = core.findIndex((unit, index) => index > 0 && PHRASE_START.test(unit.text));
  const main = phraseAt === -1 ? core : core.slice(0, phraseAt);
  // "Size 10", "Shade 150", "Brown": a variant's own value, or a value that names its dimension.
  const isVariant = (unit: Unit) =>
    variantKeys.has(labelKey(unit.text)) || inside(unit.text, variantWords) || variantDescriptor(unit.text) !== null;
  // The phrase stops at a variant's value or a quantity, and before a trailing
  // code; those are ranked on their own.
  let phraseEnd = phraseAt;
  while (phraseAt !== -1 && phraseEnd < core.length && !isVariant(core[phraseEnd]) && !QUANTITY.test(core[phraseEnd].text)) phraseEnd += 1;
  while (phraseAt !== -1 && phraseEnd - 1 > phraseAt && CODED(core[phraseEnd - 1].text)) phraseEnd -= 1;
  const phrase = phraseAt === -1 ? [] : core.slice(phraseAt, phraseEnd);

  // The product-type noun: the descriptive words that end the name ("Graphics
  // Card", "Eau de Parfum"), at most two content words, before any code or quantity.
  // Only guessed when neither the family nor the category names a word of the title.
  const head = new Set<Unit>();
  let neighbour: Unit | null = null;
  const typed = core.some((unit) => words(unit.text).some((word) => typeStems.has(stem(word))));
  if (!typed) {
    let end = main.length - 1;
    while (end > 0 && (CODED(main[end].text) || QUANTITY.test(main[end].text))) end -= 1;
    let content = 0;
    for (let index = end; index > 0; index -= 1) {
      const unit = main[index];
      if (CODED(unit.text) || QUANTITY.test(unit.text)) break;
      const lowerJoiner = /^\p{Ll}{1,3}$/u.test(unit.text);
      if (!lowerJoiner && content === 2) {
        neighbour = unit;
        break;
      }
      head.add(unit);
      if (!lowerJoiner) content += 1;
    }
  }

  const seen = new Set<string>();
  const brandSeen = new Set<string>();
  const firstWord = units.find((unit) => unit.kind === "word");
  // With no recorded model, the first word after the brand is taken to name the product line.
  const lineName = modelWords.size
    ? null
    : (main.find((unit, index) => index > 0 && !inside(unit.text, brandWords)) ?? null);
  for (const unit of units) {
    if (unit.kind === "separator") {
      unit.priority = 0;
      continue;
    }
    if (unit.kind === "aside") {
      unit.priority = 1;
      continue;
    }
    const key = labelKey(unit.text);
    const repeated = key !== "" && seen.has(key);
    seen.add(key);
    // The brand's own words, the first time they appear.
    const isBrand = !repeated && inside(unit.text, brandWords) && !words(unit.text).some((word) => brandSeen.has(word));
    if (isBrand) for (const word of words(unit.text)) brandSeen.add(word);
    const coded = CODED(unit.text);
    const quantity = QUANTITY.test(unit.text);
    const inModel = inside(unit.text, modelWords);
    const variant = isVariant(unit);
    const typeWord = words(unit.text).some((word) => typeStems.has(stem(word)));

    let priority: number;
    if (repeated) priority = 0;
    else if (unit === firstWord || unit === lineName || isBrand || variant) priority = Infinity;
    else if (unit.segment === 0 && typeWord) priority = Infinity;
    else if (head.has(unit)) priority = Infinity;
    else if (inModel && coded) priority = Infinity;
    else if (!modelWords.size && unit.segment === 0 && coded && !quantity && phrase.indexOf(unit) === -1) priority = Infinity;
    else if (PROMOTIONAL.test(unit.text) || (!inModel && Boolean(unit.text.match(EVALUATIVE_PATTERN)))) priority = 0;
    else if (quantity) priority = 6;
    else if (coded) priority = 5;
    else if (unit === neighbour) priority = 4.5;
    else if (inModel) priority = 4;
    else if (inside(unit.text, factWords)) priority = 2;
    else priority = 3;
    unit.priority = priority;
  }

  // An aside after a comma, bar or dash goes whole, with its separator — or
  // stays whole when it holds a variant's value. A short last phrase after a
  // dash names a variant ("… - 150 Buff", "– Black").
  for (let segment = 1; segment <= lastSegment; segment += 1) {
    const members = units.filter((unit) => unit.segment === segment && unit.kind !== "aside");
    const content = members.filter((unit) => unit.kind === "word");
    if (!members.length) continue;
    const variantName = segment === lastSegment && /^[-–—]$/.test(members[0].text) && content.length > 0 && content.length <= 2;
    const keep = variantName || content.some((unit) => unit.priority === Infinity && unit.text !== "");
    for (const unit of members) {
      unit.group = members[0].group;
      unit.priority = keep ? Infinity : 1;
    }
  }

  // The phrase after "for"/"with" goes whole, and only as late as its most useful word.
  if (phrase.length > 0) {
    const top = Math.max(0, ...phrase.slice(1).map((unit) => unit.priority));
    const priority = top === Infinity ? Infinity : Math.max(2, top);
    for (const unit of phrase) {
      unit.group = phrase[0].group;
      unit.priority = priority;
    }
  }
}

/** The kept units as text: joiners and separators left dangling go. */
function render(units: Unit[]): string {
  const kept = [...units];
  for (let pass = 0; pass < 6; pass += 1) {
    const before = kept.length;
    while (kept.length && (kept[0].kind === "separator" || JOINER.test(kept[0].text))) kept.shift();
    while (kept.length && (kept.at(-1)!.kind === "separator" || JOINER.test(kept.at(-1)!.text))) kept.pop();
    for (let index = kept.length - 2; index >= 0; index -= 1) {
      const next = kept[index + 1];
      const unit = kept[index];
      if ((unit.kind === "separator" || JOINER.test(unit.text)) && next.kind === "separator") kept.splice(index, 1);
    }
    if (kept.length === before) break;
  }
  return kept
    .map((unit, index) => (index > 0 && unit.text === "," ? "," : `${index > 0 ? " " : ""}${unit.text}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutSiteSuffix(title: string): string {
  let out = title.replace(/\s+/g, " ").trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const stripped = out.replace(SITE_NAME_SUFFIX, "").trim();
    if (!stripped || stripped === out) break;
    out = stripped;
  }
  return out;
}

/**
 * A product name as an SEO title of at most `max` characters, aiming for
 * `target`: whole units only, least useful first. A name that already fits
 * is returned as it is, less any site-name suffix.
 */
export function fitSeoTitle(
  raw: string,
  identity: TitleIdentity,
  options: { target?: number; max?: number } = {},
): string {
  const max = options.max ?? SEO_TITLE_MAX;
  const target = Math.min(options.target ?? SEO_TITLE_TARGET, max);
  const title = withoutSiteSuffix(raw);
  if (title.length <= target) return title;

  const units = tokenize(title);
  rank(units, identity);

  // Removal order: lowest priority first; within a priority, the rightmost group first.
  const groups = [...new Set(units.filter((unit) => unit.priority !== Infinity).map((unit) => unit.group))]
    .map((group) => ({
      group,
      priority: Math.min(...units.filter((unit) => unit.group === group).map((unit) => unit.priority)),
      at: Math.max(...units.filter((unit) => unit.group === group).map((unit) => units.indexOf(unit))),
    }))
    .sort((a, b) => a.priority - b.priority || b.at - a.at);

  const states: string[] = [render(units)];
  const removed = new Set<number>();
  for (const entry of groups) {
    removed.add(entry.group);
    states.push(render(units.filter((unit) => !removed.has(unit.group))));
  }
  const fits = (limit: number) => states.find((state) => state.length > 0 && state.length <= limit);
  const fitted = fits(target) ?? fits(max);
  if (fitted) return fitted;

  // Even the protected identity is too long: cut at a unit boundary.
  const remaining = units.filter((unit) => !removed.has(unit.group));
  let cut: Unit[] = [];
  for (const unit of remaining) {
    const next = [...cut, unit];
    if (render(next).length > max) break;
    cut = next;
  }
  // A single word longer than the limit is kept whole rather than broken.
  return render(cut) || remaining.find((unit) => unit.kind === "word")?.text || title;
}
