import { isIdentityLabel } from "@/lib/pkb/identity-labels";
import { labelKey } from "@/lib/pkb/normalize";
import { collapseRepeatedUnits } from "@/lib/pkb/unit-text";
import { isWarrantyLabel } from "@/lib/pkb/warranty-policy";
import { measurementRows, specificationRows } from "./facts";
import type { SeoPulseInput } from "./types";

/**
 * What SeoPulse writes about, decided before anything is written (D-128).
 *
 * The model is not asked to choose which facts matter, or how long to be. The
 * established facts are ranked here — by the product family's own attribute
 * order and requirement where there is a family, by how specific a value is
 * where there is not — and the model is given a bounded list and a plan.
 * Nothing here knows any brand or kind of product: a graphics card's memory
 * and a perfume's concentration rank high for the same reason, because their
 * family lists them first.
 *
 * Two surfaces are built from the same facts and must not repeat each other:
 *
 *  - **At a Glance** — label → value, short, for scanning ("Memory: 12GB
 *    GDDR7"). Deterministic, from established facts only.
 *  - **Key Points** — a line a shopper reads ("12GB GDDR7 memory"), still one
 *    established fact each, but never the same "Label: value" line.
 */

export type FactRow = { label: string; value: string };

/** Offer terms are never product facts (I-8); a warranty is Manifest's own term (D-128). */
const NOT_CONTENT = /^(price|sale price|regular price|availability|stock|in stock|shipping|delivery|what'?s in the box|box contents|in the box|country of origin)$/i;
/** A single measurement of size: several of them read as one fact at a glance. */
const DIMENSION = /\b(width|height|depth|length|thickness|dimensions?)\b/i;
/** Instructions and cautions are facts, but not what a product is. */
const INSTRUCTIONS = /\b(how to|directions?|instructions?|usage|steps?|warnings?|cautions?|precautions?|care)\b/i;

function isContentFact(row: FactRow): boolean {
  return (
    Boolean(row.label.trim() && row.value.trim()) &&
    !isIdentityLabel(row.label) &&
    !isWarrantyLabel(row.label) &&
    !NOT_CONTENT.test(row.label.trim()) &&
    !/^(no|none|n\/a|not applicable|-|—)$/i.test(row.value.trim())
  );
}

/**
 * The family's own order of importance, as label keys: required attributes
 * first, then recommended, then the rest, each in the family's order.
 */
function familyPriority(input: SeoPulseInput): string[] {
  const attributes = input.knowledge?.family?.attributes ?? [];
  const rank = { required: 0, recommended: 1, optional: 2 } as const;
  return attributes
    .map((attribute, index) => ({ key: labelKey(attribute.label), rank: rank[attribute.requirement] ?? 2, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.key);
}

/** How specific a value is, when no family says what matters: figures and short technical values first. */
function specificity(row: FactRow): number {
  const value = row.value.trim();
  let score = 0;
  if (/\p{N}/u.test(value)) score += 2;
  if (value.length <= 30) score += 1;
  if (value.length > 80) score -= 2;
  if (INSTRUCTIONS.test(row.label)) score -= 3;
  return score;
}

/**
 * The established facts SeoPulse may write about, most useful first, at most
 * `limit` — not every fact the product has, so a model is not handed dozens
 * of minor ones.
 */
export function prioritizedFacts(input: SeoPulseInput, limit = 12): FactRow[] {
  const rows = [...specificationRows(input), ...measurementRows(input)]
    .map((row) => ({ label: row.label.trim(), value: collapseRepeatedUnits(row.value.trim()) }))
    .filter(isContentFact);
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = labelKey(row.label);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const priority = familyPriority(input);
  const position = (row: FactRow) => {
    const index = priority.indexOf(labelKey(row.label));
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return unique
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        position(a.row) - position(b.row) ||
        specificity(b.row) - specificity(a.row) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * At a Glance: at most `max` short label → value facts for scanning. Pure;
 * the product page and SeoPulse use the same rule. Values too long to scan,
 * identifiers, offer terms, warranties and instructions are left out.
 */
export function atAGlance(rows: FactRow[], options: { priority?: string[]; max?: number } = {}): FactRow[] {
  const max = options.max ?? 5;
  const priority = (options.priority ?? []).map(labelKey);
  const candidates = rows
    .map((row) => ({ label: row.label.trim(), value: collapseRepeatedUnits(row.value.trim()) }))
    .filter((row) => isContentFact(row) && !INSTRUCTIONS.test(row.label) && row.label.length <= 28 && row.value.length <= 40);
  const seen = new Set<string>();
  let dimensions = 0;
  return candidates
    .map((row, index) => {
      const at = priority.indexOf(labelKey(row.label));
      return { row, index, at: at === -1 ? Number.POSITIVE_INFINITY : at };
    })
    .sort((a, b) => a.at - b.at || specificity(b.row) - specificity(a.row) || a.index - b.index)
    .map((entry) => entry.row)
    .filter((row) => {
      const key = labelKey(row.label);
      if (seen.has(key)) return false;
      seen.add(key);
      // Width, height and depth are one fact for scanning: at most one of them.
      if (DIMENSION.test(row.label) && ++dimensions > 1) return false;
      return true;
    })
    .slice(0, max);
}

/** Words a label adds to say what kind of property it is, not what it is about. */
const GENERIC_LABEL_WORDS = new Set(["type", "kind", "style", "name", "format", "system", "method", "level", "rating"]);

/** Lower-cases a label for use inside a sentence, keeping acronyms and model words: "CUDA Cores" → "CUDA cores". */
function inSentence(label: string): string {
  return label
    .split(/\s+/)
    .map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/**
 * One established fact as a Key Point a shopper reads, rather than the
 * "Label: value" line At a Glance shows:
 *
 *   Memory: 12GB GDDR7     → 12GB GDDR7 memory
 *   Architecture: Blackwell → Blackwell architecture
 *   Wireless charging: Yes  → Wireless charging
 *   Colour: Black          → Black colour
 *
 * Nothing is added that the fact does not say. A value that already names
 * its property, or is a sentence, is used as it is. Null for a "No".
 */
export function keyPointFromFact(label: string, rawValue: string): string | null {
  const value = collapseRepeatedUnits(rawValue.trim()).replace(/[.;,]+$/, "");
  const name = label.trim().replace(/[:：]\s*$/, "");
  if (!value || !name) return null;
  if (/^(no|none|n\/a|not applicable)$/i.test(value)) return null;
  if (/^(yes|included|supported|available|true)$/i.test(value)) return name;
  const valueWords = labelKey(value).split(" ");
  // "Switch type: Glorious mechanical switches" names its property already; "type" says nothing.
  const labelWords = labelKey(name)
    .split(" ")
    .filter((word) => word.length > 2 && !GENERIC_LABEL_WORDS.has(word));
  const alreadyNamed = labelWords.length > 0 && labelWords.every((word) => valueWords.some((value) => value === word || value === `${word}s` || value === `${word}es`));
  if (alreadyNamed || value.split(/\s+/).length > 8) return value.charAt(0).toUpperCase() + value.slice(1);
  const line = `${value} ${inSentence(name)}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * One established fact as words inside a sentence (D-129): the Key Point
 * wording, with the fact's own case kept ("12GB GDDR7 memory", "wireless
 * charging"), not capitalised as a line of its own.
 */
export function inlineFact(label: string, rawValue: string): string | null {
  const point = keyPointFromFact(label, rawValue);
  if (!point) return null;
  const value = collapseRepeatedUnits(rawValue.trim());
  const yes = /^(yes|included|supported|available|true)$/i.test(value);
  const source = yes ? inSentence(label.trim()) : value;
  const first = source.split(/\s+/)[0] ?? "";
  // "Wireless charging: Yes" reads "wireless charging"; a value's own capital ("Blackwell") stays.
  const lower = yes ? /^\p{Lu}\p{Ll}+$/u.test(first) : /^\p{Ll}/u.test(source);
  return lower ? point.charAt(0).toLowerCase() + point.slice(1) : point;
}

/** A label naming who makes a part, not a property of the product. */
const COMPANY_LABEL = /\b(?:manufacturer|maker|brand|vendor|supplier|made by)$/i;

/** Weights and counts: measurements, like dimensions. */
const MEASURE_LABEL = /\b(weight|mass|count|quantity|pieces|pack size)\b/i;

/** "a", "a and b", "a, b and c" — from items already cleaned of stray joiners and punctuation. */
function spokenList(items: string[]): string {
  const clean = items
    .map((item) => item.replace(/\s+/g, " ").replace(/^(?:and|or)\s+|[\s,;]+$|^[\s,;]+/gi, "").trim())
    .filter(Boolean);
  return clean.length <= 1 ? (clean[0] ?? "") : `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`;
}

/**
 * "the <name>", or the name alone when it already starts with an article
 * ("The Ordinary …"), so a sentence never reads "the The …".
 */
function theName(name: string): string {
  return /^(?:the|a|an)\s/i.test(name) ? name : `the ${name}`;
}

/** One sentence, tidied of what a template can leave: doubled spaces, a space before a comma, a comma before the full stop. */
function tidySentence(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/,+/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\b(and|or)\s+\1\b/gi, "$1")
    .trim();
}

/*
 * Sentences about a product never guess its grammatical number (D-130).
 * "<name> has …" / "<name> have …" was chosen from the name's last word,
 * and a product name is not an English noun phrase: "… Series", "… Lens",
 * "… Edition" read as plural or singular by accident. The subject is now a
 * noun whose number is fixed — "Key specifications of the <name> include …"
 * — so the verb never depends on the name. "include" is also right for any
 * fact: a colour, a clock speed or a port is a specification, where "features
 * 500 g" would not be.
 */

/** The sentence that names a product when no fact reads well in one: nothing about it is claimed. */
export function identitySentence(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean ? tidySentence(`This listing is for ${theName(clean)}.`) : "";
}

/**
 * The few facts a sentence about the product can carry (D-129): the plan's
 * own ranking, figures and codes first because they read most plainly inside
 * a sentence, and never a fact the name already says, a list, or a long value.
 */
export function sentenceFacts(plan: Pick<ContentPlan, "facts" | "exactName">, max: number): string[] {
  const nameWords = new Set(labelKey(plan.exactName).split(" "));
  const candidates: { text: string; index: number; figure: number }[] = [];
  plan.facts.forEach((row, index) => {
    if (row.value.length > 40 || /[,;:.](?:\s|$)/.test(row.value) || INSTRUCTIONS.test(row.label)) return;
    // "Chipset manufacturer: NVIDIA" names a company, not something the product has (found live, D-129).
    if (COMPANY_LABEL.test(row.label.trim())) return;
    // Sizes, weights and counts are for scanning (At a Glance), not what a product has; a raw key ("milliamp_hours") is not English.
    if (DIMENSION.test(row.label) || MEASURE_LABEL.test(row.label) || /\p{L}_\p{L}/u.test(row.value)) return;
    if (labelKey(row.value).split(" ").every((word) => nameWords.has(word))) return;
    const text = inlineFact(row.label, row.value);
    if (!text || text.split(/\s+/).length > 6) return;
    candidates.push({ text, index, figure: /\p{N}|\p{Lu}{2,}/u.test(row.value) ? 0 : 1 });
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of candidates.sort((a, b) => a.figure - b.figure || a.index - b.index)) {
    const key = labelKey(entry.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.text);
  }
  return out.slice(0, max);
}

/**
 * A short, plain opening that names the product (D-129), used when the
 * generated opening could not be kept and nothing near the start of the
 * description still says which product it is: "Key specifications of the
 * <name> include <fact> and <fact>." (D-130), or only "This listing is for
 * the <name>." when no fact reads well in a sentence. Deterministic; nothing
 * is added that the facts do not say, and no verb depends on the name.
 */
export function openingSentence(plan: Pick<ContentPlan, "facts" | "exactName">): string {
  const name = plan.exactName.replace(/\s+/g, " ").trim();
  if (!name) return "";
  const facts = sentenceFacts(plan, 2);
  return facts.length ? tidySentence(`Key specifications of ${theName(name)} include ${spokenList(facts)}.`) : identitySentence(name);
}

/**
 * A meta description as one sentence from established facts (D-129): "Key
 * specifications of the <name> include <fact>, <fact> and <fact>." (D-130) —
 * at most three, fewer when that is all that fits in `max` — with ", intended
 * for <use>," only when the listing states a use. Staff's own feature lines,
 * when they stand in, are "key features". Empty when nothing reads well in a
 * sentence: no snippet is better than filler.
 */
export function factMetaSentence(
  plan: Pick<ContentPlan, "facts" | "exactName">,
  options: { name?: string; use?: string | null; extra?: string[]; max?: number } = {},
): string {
  const name = (options.name ?? plan.exactName).replace(/\s+/g, " ").trim();
  const max = options.max ?? 155;
  const established = sentenceFacts(plan, 3);
  const facts = established.length ? established : (options.extra ?? []).slice(0, 3);
  if (!name || facts.length === 0) return "";
  const kind = established.length ? "specifications" : "features";
  const use = options.use?.replace(/\s+/g, " ").replace(/[.,;:\s]+$/, "").trim();
  for (let count = facts.length; count >= 1; count -= 1) {
    for (const withUse of use ? [true, false] : [false]) {
      const subject = `Key ${kind} of ${theName(name)}${withUse ? `, intended for ${use},` : ""}`;
      const sentence = tidySentence(`${subject} include ${spokenList(facts.slice(0, count))}.`);
      if (sentence.length <= max) return sentence;
    }
  }
  return "";
}

/** "Memory: 12GB GDDR7" — a line that is only a label and its value. */
export function labelValueLine(line: string): FactRow | null {
  const match = /^\s*([^:：]{1,40})[:：]\s*(.+?)\s*$/.exec(line);
  return match ? { label: match[1].trim(), value: match[2].trim() } : null;
}

export type ContentDepth = "simple" | "medium" | "detailed";

/**
 * What a property is about, from its label's own words: the build of a
 * product, or how it connects to or is used with something else. Kinds of
 * property, not kinds of product — "Material" is build for a shoe and a
 * sofa alike, "Ports" is connection for a charger and a laptop alike.
 */
const BUILD = /\b(material|materials|fabric|finish|colou?r|shade|dimensions?|size|weight|height|width|length|depth|build|construction|cooling|fans?|frame|body|case|housing|upper|sole|lining|closure|fit|texture|design|form factor|shape|thickness)\b/i;
const CONNECTION = /\b(ports?|interface|connect(?:ion|ivity|or)?|bluetooth|wi-?fi|wireless|usb|hdmi|displayport|compatib\w*|protocol|input|output|socket|slot|mount|platform|operating system|os|app|suitable for|skin type|hair type|use|usage|application|pairing)\b/i;

/**
 * The description's sections, chosen from the facts there are (D-128): a
 * section appears only when some prioritised fact belongs in it, so a perfume
 * gets no connectivity paragraph and a cable gets a short description.
 */
function blueprint(facts: FactRow[], depth: ContentDepth): string[] {
  const has = (pattern: RegExp) => facts.some((row) => pattern.test(row.label));
  return [
    "What the product is, naming it exactly once",
    ...(facts.length > 1 ? ["Its most important capabilities or features"] : []),
    ...(depth !== "simple" && has(BUILD) ? ["Design, build or materials"] : []),
    ...(depth !== "simple" && has(CONNECTION) ? ["Compatibility, connectivity or use"] : []),
    ...(depth === "detailed" ? ["What to check before buying, from the facts only"] : []),
  ];
}

export type ContentPlan = {
  /** The exact product name, to be used once, near the start. */
  exactName: string;
  /** Shorter references built from the product's own identity, for after that. */
  shortNames: string[];
  /** The facts to write about, most important first. */
  facts: FactRow[];
  /** What At a Glance shows, so Key Points can say something else. */
  atAGlance: FactRow[];
  depth: ContentDepth;
  /** Guidance, not a limit: never pad to reach it. */
  usefulWords: string;
  sections: string[];
  /** The listing's own warranty, entered by staff — the only warranty that may be mentioned. */
  manualWarranty: string | null;
};

/** The plan SeoPulse's one generation follows. Pure. */
export function contentPlan(input: SeoPulseInput): ContentPlan {
  const facts = prioritizedFacts(input);
  const glance = atAGlance(facts, { priority: familyPriority(input) });
  const depth: ContentDepth = facts.length <= 4 ? "simple" : facts.length <= 9 ? "medium" : "detailed";
  const brand = (input.knowledge?.brand ?? input.brand ?? "").trim();
  const model = (input.knowledge?.modelName ?? input.details?.modelName ?? input.details?.modelNumber ?? "").trim();
  const exactName = input.title.trim();
  const shortNames = [
    brand && model && !labelKey(model).includes(labelKey(brand)) ? `${brand} ${model}` : "",
    model,
  ]
    .map((name) => name.trim())
    .filter((name, index, all) => name.length >= 3 && labelKey(name) !== labelKey(exactName) && all.indexOf(name) === index);
  const sections = blueprint(facts, depth);
  const warranty = input.warranty;
  return {
    exactName,
    shortNames,
    facts,
    atAGlance: glance,
    depth,
    usefulWords: depth === "simple" ? "about 120–200" : depth === "medium" ? "about 200–400" : "about 350–600",
    sections,
    manualWarranty: warranty
      ? warranty.hasWarranty
        ? warranty.durationMonths
          ? `${warranty.durationMonths}-month warranty`
          : "Covered by a warranty"
        : "No warranty"
      : null,
  };
}
