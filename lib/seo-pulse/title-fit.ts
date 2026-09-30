import { labelKey } from "@/lib/pkb/normalize";
import { variantDescriptor } from "@/lib/pkb/identity-labels";
import { EVALUATIVE_PATTERN } from "./claim-words";
import {
  identityValues,
  listingVocabulary,
  stem,
  structuredProductTypes,
  words,
  type ProductTypeResolution,
  type ProductTypeSource,
  type StructuredTypeSource,
} from "./product-type";
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
 *   6  a quantity ("12GB", "50 ml") — since D-130 in the strong tier below
 *
 * D-129 never took out the brand, the first word, a code in the model name
 * ("EPIC-X", "WH-1000XM5"), the product-type noun at the end of the name
 * ("Graphics Card", "Eau de Parfum"), a word the family or category names,
 * or a variant's value (colour, size, shade), and cut a name whose protected
 * identity passed 60 at a unit boundary. The title aims for 49 characters so
 * the page title, with " · Manifest", stays within 60, and may use up to 60
 * (the readiness policy, lib/seo/readiness.ts) rather than lose identity.
 * Nothing here knows any brand or kind of product.
 *
 * D-130 puts an order on the protected units, because "protected" had come to
 * cover a guess as firmly as a model code:
 *
 *   normal    0–6 above, taken out first
 *   2.5       after a confirmed product type, the descriptive tail that
 *             follows it ("… Olive Oil Cold Pressed Glass Bottle"), whole
 *   strong    7–8.5: a product line read from the name, a quantity no
 *             variant records, a product type guessed from the end of the
 *             name. Taken out, in that order, only when the title would
 *             otherwise miss its target.
 *   critical  the brand, the recorded model's name and codes and the short
 *             word that completes a code ("Ti", "Pro"), a recorded variant
 *             value, a generation ("Gen 3"), every code in a name with no
 *             recorded model, and the product type a family, a specific
 *             category, a recorded product type or the listing's own words
 *             confirm (lib/seo-pulse/product-type.ts). A type that cannot be
 *             told is not guessed: nothing is protected as the type.
 *
 * Critical identity is kept even past 60, up to the 70 characters a stored
 * SEO title holds: two variants must never shorten to the same title. Only
 * past 70 does the product type go, and only past that is the name cut.
 */

/** Readiness policy (lib/seo/readiness.ts): an SEO title of 30–60 characters. */
export const SEO_TITLE_MAX = 60;
/** The layout appends the site's name to every page title (app/layout.tsx). */
export const SITE_TITLE_SUFFIX = " · Manifest";
/** What a title aims for, so the page title with the site's name fits in 60. */
export const SEO_TITLE_TARGET = SEO_TITLE_MAX - SITE_TITLE_SUFFIX.length;
/**
 * The most a title may use to keep its critical identity (D-130): what a
 * stored SEO title holds (`seoTitle` in lib/seo-pulse/types.ts). Past 60 the
 * readiness check reports the title as long, which is the honest outcome for
 * a product whose identity is that long.
 */
export const SEO_TITLE_HARD_MAX = 70;
/** " · Manifest", " | Manifest", " - Manifest" at the end of a title. */
export const SITE_NAME_SUFFIX = /\s*[·|\-–—:]\s*manifest\s*$/i;

export type TitleIdentity = {
  brand: string | null;
  /** The recorded model name and number. */
  model: string | null;
  /**
   * Names of the kind of product, strongest first: the family, a specific
   * category, a recorded product type (D-130, lib/seo-pulse/product-type.ts).
   * A broad grouping is not among them.
   */
  productType: string[];
  /** Where each `productType` name came from, in the same order. */
  typeSources?: StructuredTypeSource[];
  /** Values one product or variant differs from another in: colour, size, shade, capacity, generation … */
  variants: string[];
  /** Established fact values, lower-cased. */
  factText: string;
  /**
   * The listing's own words about itself — search keywords, tags, staff copy,
   * never SeoPulse's (D-120) — which can confirm which words of the name are
   * its type when no structured name does (D-130).
   */
  vocabulary?: string;
};

export function titleIdentity(input: SeoPulseInput): TitleIdentity {
  const details = input.details ?? {};
  const types = structuredProductTypes(input);
  return {
    brand: (input.knowledge?.brand ?? input.brand ?? "").trim() || null,
    model: [input.knowledge?.modelName ?? details.modelName ?? "", details.modelNumber ?? ""].join(" ").trim() || null,
    productType: types.map((type) => type.name),
    typeSources: types.map((type) => type.source),
    variants: identityValues(input),
    factText: [
      ...(input.knowledge?.attributes ?? []).map((attribute) => attribute.value ?? ""),
      ...(input.specifications ?? []).map((row) => row.value),
    ]
      .join(" \n ")
      .toLowerCase(),
    vocabulary: listingVocabulary(input),
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
  /** The brand, a recorded variant's value, a generation, the model's name: the last to go past the hard maximum (D-130). */
  anchor?: boolean;
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
      // "11 Tablet" names a model, "60 Tablets" and "1 Tablet" a count (D-130).
      const countWord = next !== undefined && /^(?:tablet|capsule|piece|sheet)$/i.test(next) && token !== "1";
      if (next && UNIT_TOKEN.test(next) && !countWord) {
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
    if (/^gen(?:eration)?\.?$/i.test(token) && previous?.kind === "word" && /^\d+(?:st|nd|rd|th)$/i.test(previous.text)) {
      // "3rd Gen": one unit, as "Gen 3" is.
      previous.text = `${previous.text} ${token}`;
      continue;
    }
    units.push({ text: token, kind: "word", segment, group: units.length, priority: 0 });
  }
  return units;
}

/** "Gen 3", "Generation 2", "3rd Gen", "2nd Generation": which generation a product is. */
const GENERATION = /^(?:gen(?:eration)?\.?\s?\d+|\d+(?:st|nd|rd|th)\s+gen(?:eration)?\.?)$/i;
/** An -ed word ("Pressed", "Refined"): a process or state, which after the start of a name begins a descriptive tail. */
const PARTICIPLE = /^\p{L}{3,}ed$/u;
/** A short word that completes a model code: "Ti", "Pro", "Max", "Plus", "S". */
const SUFFIX = /^\p{L}{1,5}$/u;

/*
 * The strong tier (D-130): protected from the normal removals, but taken out
 * before a title misses its target. Lowest first.
 */
/** A product line read from the name, or a first word that is not the brand. */
const STRONG_LINE = 7;
/** A quantity no variant records ("12GB", "50 ml"). */
const STRONG_QUANTITY = 8;
/** A product type guessed from the end of the name. */
const STRONG_GUESSED_TYPE = 8.5;
const STRONG_MAX = STRONG_GUESSED_TYPE;
/** A confirmed product type, or a first word standing in for an unknown brand: goes only past the hard maximum. */
const CRITICAL_TYPE = 9;
/** A descriptive word after a confirmed product type ("… Olive Oil Cold Pressed Glass Bottle"). */
const DESCRIPTIVE_TAIL = 2.5;

type TypeFinding = { units: Unit[]; source: ProductTypeSource | null };

/** Ranks every unit; `Infinity` is never removed. Returns the units that say what the product is. */
function rank(units: Unit[], identity: TitleIdentity, title: string): TypeFinding {
  const brandWords = new Set(words(identity.brand ?? ""));
  const modelWords = new Set(words(identity.model ?? ""));
  const typeStems = new Set(identity.productType.flatMap(words).map(stem));
  const compact = (text: string) => labelKey(text).replace(/ /g, "");
  const variantKeys = new Set(identity.variants.flatMap((value) => [labelKey(value), compact(value)]).filter(Boolean));
  const variantWords = new Set(identity.variants.flatMap(words));
  const factWords = new Set(words(identity.factText).filter((word) => word.length >= 3));
  const inside = (text: string, set: Set<string>) => words(text).length > 0 && words(text).every((word) => set.has(word));
  const lastSegment = Math.max(...units.map((unit) => unit.segment));

  // The name itself is segment 0; a phrase after "for"/"with" in it is one removable group.
  const core = units.filter((unit) => unit.segment === 0 && unit.kind === "word");
  const phraseAt = core.findIndex((unit, index) => index > 0 && PHRASE_START.test(unit.text));
  const main = phraseAt === -1 ? core : core.slice(0, phraseAt);
  // "Size 10", "Shade 150", "Brown", "256GB": a recorded value, or a value that names its dimension.
  const isVariant = (unit: Unit) =>
    variantKeys.has(labelKey(unit.text)) ||
    variantKeys.has(compact(unit.text)) ||
    inside(unit.text, variantWords) ||
    variantDescriptor(unit.text) !== null;
  // The phrase stops at a variant's value or a quantity, and before a trailing
  // code; those are ranked on their own.
  let phraseEnd = phraseAt;
  while (phraseAt !== -1 && phraseEnd < core.length && !isVariant(core[phraseEnd]) && !QUANTITY.test(core[phraseEnd].text)) phraseEnd += 1;
  while (phraseAt !== -1 && phraseEnd - 1 > phraseAt && CODED(core[phraseEnd - 1].text)) phraseEnd -= 1;
  const phrase = phraseAt === -1 ? [] : core.slice(phraseAt, phraseEnd);

  // Praise spelled over two words ("Long Lasting") is praise in both.
  const praisePairs = new Set<Unit>();
  for (let index = 1; index < core.length; index += 1) {
    const pair = `${core[index - 1].text} ${core[index].text}`;
    if (pair.match(EVALUATIVE_PATTERN)?.[0]?.length === pair.length) {
      praisePairs.add(core[index - 1]);
      praisePairs.add(core[index]);
    }
  }
  const praise = (unit: Unit) => praisePairs.has(unit) || PROMOTIONAL.test(unit.text) || Boolean(unit.text.match(EVALUATIVE_PATTERN));
  const lowerJoiner = (unit: Unit) => /^\p{Ll}{1,3}$/u.test(unit.text);
  // A word that can say what the product is: not the brand, a code, a quantity, a variant's value or praise.
  const plainWord = (unit: Unit) =>
    unit.kind === "word" && !CODED(unit.text) && !QUANTITY.test(unit.text) && !isVariant(unit) && !inside(unit.text, brandWords) && !praise(unit);

  /*
   * What the product is (D-130; lib/seo-pulse/product-type.ts), strongest
   * source first: a structured name — family, specific category, recorded
   * product type — found in the name; else a phrase of the name the listing's
   * own words repeat; else the name's closing words, unless the name shows a
   * descriptive tail ("… Olive Oil Cold Pressed Glass Bottle") and the type
   * is left unknown rather than guessed.
   */
  const finding: TypeFinding = { units: [], source: null };
  let typeTier = CRITICAL_TYPE;
  let neighbour: Unit | null = null;

  const structuredIndex = identity.productType.findIndex((name) => {
    const stems = new Set(words(name).map(stem));
    return core.some((unit) => words(unit.text).some((word) => stems.has(stem(word))));
  });
  if (structuredIndex !== -1) {
    finding.units = core.filter((unit) => words(unit.text).some((word) => typeStems.has(stem(word))));
    finding.source = identity.typeSources?.[structuredIndex] ?? "family";
  }

  if (!finding.units.length && identity.vocabulary) {
    const titleKey = words(title).map(stem).join(" ");
    const entries = identity.vocabulary
      .split("\n")
      .map((entry) => ` ${words(entry).map(stem).join(" ")} `.split(` ${titleKey} `).join(" "));
    const occurrences = (key: string) => entries.reduce((count, entry) => count + entry.split(` ${key} `).length - 1, 0);
    type Candidate = { span: Unit[]; content: number; count: number; stated: boolean; at: number };
    const candidates: Candidate[] = [];
    for (let start = 1; start < main.length; start += 1) {
      if (!plainWord(main[start]) || lowerJoiner(main[start])) continue;
      const span: Unit[] = [];
      let content = 0;
      for (let end = start; end < main.length && content < 2; end += 1) {
        const unit = main[end];
        if (!plainWord(unit)) break;
        span.push(unit);
        if (lowerJoiner(unit)) continue;
        content += 1;
        // A phrase that ends on a process ("Cold Pressed", "Cleansing") is not a kind of product.
        if (PARTICIPLE.test(unit.text) || /ing$/i.test(unit.text)) continue;
        const count = occurrences(span.flatMap((member) => words(member.text)).map(stem).join(" "));
        if (count > 0) {
          const stated = span.filter((member) => !lowerJoiner(member)).every((member) => inside(member.text, factWords));
          candidates.push({ span: [...span], content, count, stated, at: end });
        }
      }
    }
    const best = candidates.sort(
      (a, b) => Number(a.stated) - Number(b.stated) || b.content - a.content || b.count - a.count || b.at - a.at,
    )[0];
    if (best) {
      finding.units = best.span;
      finding.source = "title";
    }
  }

  if (!finding.units.length) {
    // The descriptive words that end the name ("Graphics Card", "Eau de
    // Parfum"), at most two content words, before any code, quantity or
    // variant's value.
    const head: Unit[] = [];
    let end = main.length - 1;
    while (end > 0 && (CODED(main[end].text) || QUANTITY.test(main[end].text) || isVariant(main[end]))) end -= 1;
    let content = 0;
    let start = end + 1;
    for (let index = end; index > 0; index -= 1) {
      const unit = main[index];
      if (CODED(unit.text) || QUANTITY.test(unit.text)) break;
      if (!lowerJoiner(unit) && content === 2) {
        neighbour = unit;
        break;
      }
      head.unshift(unit);
      start = index;
      if (!lowerJoiner(unit)) content += 1;
    }
    // Signs the end of the name only describes: an -ed word between the
    // start of the name and those words, or one of them a value the facts
    // state (a material, a container). Then the type is unknown.
    const tail = main.slice(1, start).some((unit) => PARTICIPLE.test(unit.text) && plainWord(unit) && !inside(unit.text, modelWords));
    const stated = head.some((unit) => !lowerJoiner(unit) && inside(unit.text, factWords));
    if (head.length && !tail && !stated) {
      finding.units = head;
      finding.source = "title";
      typeTier = STRONG_GUESSED_TYPE;
    } else {
      // Unknown: nothing is protected as the type, and the name is shortened
      // from its end like any other descriptive words.
      neighbour = null;
    }
  }
  const typeUnits = new Set(finding.units);

  const seen = new Set<string>();
  const brandSeen = new Set<string>();
  const firstWord = units.find((unit) => unit.kind === "word");
  // The recorded model's own first word, where the name uses it ("Slate" of "Slate 11").
  const modelFirst = words(identity.model ?? "")[0];
  const modelName = modelFirst ? (core.find((unit) => words(unit.text)[0] === modelFirst && inside(unit.text, modelWords)) ?? null) : null;
  // With no recorded model, the first word after the brand is taken to name the product line.
  const lineName = modelWords.size
    ? null
    : (main.find((unit, index) => index > 0 && !inside(unit.text, brandWords)) ?? null);
  // A short word right after a model code completes it ("Vx-70 Ti", "S24 Ultra").
  const suffixes = new Map<Unit, number>();
  for (let index = 1; index < core.length; index += 1) {
    const unit = core[index];
    const before = core[index - 1];
    if (!SUFFIX.test(unit.text) || lowerJoiner(unit) || inside(unit.text, factWords) || !CODED(before.text) || QUANTITY.test(before.text)) continue;
    if (modelWords.size && inside(unit.text, modelWords) && inside(before.text, modelWords)) suffixes.set(unit, Infinity);
    else if (!modelWords.size) suffixes.set(unit, STRONG_LINE);
  }

  for (const unit of units) {
    if (unit.kind === "separator") {
      unit.priority = 0;
      continue;
    }
    if (unit.kind === "aside") {
      // A bracket holding a variant's value or a generation stays; one holding a quantity goes late.
      const parts = unit.text.replace(/^[([]|[)\]]$/g, "").split(/\s*[,/|;]\s*/).filter(Boolean);
      unit.priority = parts.some((part) => variantKeys.has(labelKey(part)) || variantKeys.has(compact(part)) || variantDescriptor(part) !== null || GENERATION.test(part))
        ? Infinity
        : parts.some((part) => QUANTITY.test(part))
          ? STRONG_QUANTITY
          : 1;
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

    let priority: number;
    unit.anchor = !repeated && (isBrand || isVariant(unit) || GENERATION.test(unit.text) || unit === modelName);
    if (repeated) priority = 0;
    else if (unit.anchor) priority = Infinity;
    else if (inModel && coded) priority = Infinity;
    else if (suffixes.has(unit)) priority = suffixes.get(unit)!;
    else if (!modelWords.size && unit.segment === 0 && coded && !quantity && phrase.indexOf(unit) === -1) priority = Infinity;
    else if (typeUnits.has(unit)) priority = typeTier;
    else if (unit === firstWord) priority = identity.brand ? (praise(unit) ? 0 : STRONG_LINE) : CRITICAL_TYPE;
    else if (unit === lineName && !praise(unit)) priority = STRONG_LINE;
    else if (PROMOTIONAL.test(unit.text) || (!inModel && praise(unit))) priority = 0;
    else if (quantity) priority = STRONG_QUANTITY;
    else if (coded) priority = 5;
    else if (unit === neighbour) priority = 4.5;
    else if (inModel) priority = 4;
    else if (inside(unit.text, factWords)) priority = 2;
    else priority = 3;
    unit.priority = priority;
  }

  // A type's words go together, so half of it is never left behind.
  const typeMembers = finding.units.filter((unit) => unit.priority === typeTier);
  for (const unit of typeMembers) unit.group = typeMembers[0].group;

  // A joiner inside a variant's value ("Wi-Fi + Cellular") stays with it.
  for (let index = 1; index + 1 < core.length; index += 1) {
    if (JOINER.test(core[index].text) && core[index - 1].anchor && core[index + 1].anchor && isVariant(core[index - 1]) && isVariant(core[index + 1])) {
      core[index].priority = Infinity;
    }
  }

  // "Cold Pressed", "Vacuum Insulated": a word and the -ed word it qualifies go together.
  for (let index = 1; index < main.length; index += 1) {
    const [before, unit] = [main[index - 1], main[index]];
    if (PARTICIPLE.test(unit.text) && !PARTICIPLE.test(before.text) && plainWord(unit) && plainWord(before) && unit.priority === before.priority && unit.priority < STRONG_LINE) {
      unit.group = before.group;
    }
  }

  // After a confirmed type, what the name adds only describes it: it goes
  // whole, before other descriptive words, so no fragment of it is left.
  if (typeTier === CRITICAL_TYPE && finding.units.length) {
    const last = Math.max(...finding.units.map((unit) => main.indexOf(unit)));
    const tail = (last === -1 ? [] : main.slice(last + 1)).filter((unit) => unit.priority === 3 && plainWord(unit));
    for (const unit of tail) {
      unit.priority = DESCRIPTIVE_TAIL;
      unit.group = tail[0].group;
    }
  }

  // An aside after a comma, bar or dash goes whole, with its separator — or
  // stays whole when it holds a variant's value. A short last phrase after a
  // dash names a variant ("… - 150 Buff", "– Black"). One holding a quantity
  // no variant records goes only with the strong tier.
  for (let segment = 1; segment <= lastSegment; segment += 1) {
    const members = units.filter((unit) => unit.segment === segment && unit.kind !== "aside");
    const content = members.filter((unit) => unit.kind === "word");
    if (!members.length) continue;
    const variantName = segment === lastSegment && /^[-–—]$/.test(members[0].text) && content.length > 0 && content.length <= 2;
    const keep = variantName || content.some((unit) => unit.priority === Infinity && unit.text !== "");
    const counted = content.some((unit) => QUANTITY.test(unit.text));
    for (const unit of members) {
      unit.group = members[0].group;
      unit.priority = keep ? Infinity : counted ? STRONG_QUANTITY : 1;
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

  return finding;
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
 * A product name as an SEO title, aiming for `target` characters and keeping
 * within `max` when it can: whole units only, least useful first. A name that
 * already fits is returned as it is, less any site-name suffix.
 *
 * The length is a goal; the identity is not (D-130). When the critical
 * identity alone is longer than `max`, it is kept, up to `hardMax` (the 70 a
 * stored title holds). Past that a confirmed product type goes, and only then
 * is the name cut at a unit boundary.
 */
export function fitSeoTitle(
  raw: string,
  identity: TitleIdentity,
  options: { target?: number; max?: number; hardMax?: number } = {},
): string {
  const max = options.max ?? SEO_TITLE_MAX;
  const target = Math.min(options.target ?? SEO_TITLE_TARGET, max);
  const hardMax = Math.max(max, options.hardMax ?? SEO_TITLE_HARD_MAX);
  const title = withoutSiteSuffix(raw);
  if (title.length <= target) return title;

  const units = tokenize(title);
  rank(units, identity, title);

  // Removal order: lowest priority first; within a priority, the rightmost group first.
  const groups = [...new Set(units.filter((unit) => unit.priority !== Infinity).map((unit) => unit.group))]
    .map((group) => ({
      group,
      priority: Math.min(...units.filter((unit) => unit.group === group).map((unit) => unit.priority)),
      at: Math.max(...units.filter((unit) => unit.group === group).map((unit) => units.indexOf(unit))),
    }))
    .sort((a, b) => a.priority - b.priority || b.at - a.at);

  // Each state is the title after one more group has gone, with the tier that group came from.
  const states: { text: string; tier: number }[] = [{ text: render(units), tier: 0 }];
  const removed = new Set<number>();
  for (const entry of groups) {
    removed.add(entry.group);
    states.push({ text: render(units.filter((unit) => !removed.has(unit.group))), tier: entry.priority });
  }
  const within = (limit: number, tier: number) =>
    states.find((state) => state.text.length > 0 && state.text.length <= limit && state.tier <= tier)?.text;
  // Everything below the critical identity taken out.
  const critical = states.filter((state) => state.tier <= STRONG_MAX).at(-1)?.text ?? "";
  const fitted =
    within(target, STRONG_MAX) ??
    within(max, STRONG_MAX) ??
    (critical && critical.length <= hardMax ? critical : undefined) ??
    within(hardMax, Infinity);
  if (fitted) return fitted;

  // Even the critical identity is too long to store. Whole codes go first,
  // rightmost first; the brand, the model's name, a variant's value and a
  // generation go last, and only then is the name cut at a unit boundary.
  let remaining = units.filter((unit) => !removed.has(unit.group));
  for (let index = remaining.length - 1; index > 0 && render(remaining).length > hardMax; index -= 1) {
    if (remaining[index].kind === "word" && !remaining[index].anchor) remaining = remaining.filter((_, at) => at !== index);
  }
  if (render(remaining).length <= hardMax) return render(remaining);
  let cut: Unit[] = [];
  for (const unit of remaining) {
    const next = [...cut, unit];
    if (render(next).length > hardMax) break;
    cut = next;
  }
  // A single word longer than the limit is kept whole rather than broken.
  return render(cut) || remaining.find((unit) => unit.kind === "word")?.text || title;
}

/**
 * What the product is, for SeoPulse (D-130): the structured name when the
 * family, a specific category or a recorded product type says it; else the
 * words of the name the listing's own vocabulary repeats, or its closing
 * words when nothing suggests a descriptive tail; else unknown.
 */
export function resolveProductType(input: SeoPulseInput): ProductTypeResolution {
  const identity = titleIdentity(input);
  const title = withoutSiteSuffix(input.title);
  const finding = rank(tokenize(title), identity, title);
  if (finding.source && finding.source !== "title") return { type: render(finding.units), source: finding.source };
  if (identity.productType.length) return { type: identity.productType[0], source: identity.typeSources?.[0] ?? "family" };
  if (finding.units.length) return { type: render(finding.units), source: "title" };
  return { type: null, source: null };
}
