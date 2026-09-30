import { labelKey } from "@/lib/pkb/normalize";
import { textLanguage } from "@/lib/pkb/language";
import { stripDecoration } from "@/lib/pkb/candidate-quality";
import { collapseRepeatedUnits } from "@/lib/pkb/unit-text";
import { mentionsWarranty } from "@/lib/pkb/warranty-policy";
import { contentPlan, keyPointFromFact, labelValueLine, type ContentPlan } from "./content-plan";
import { sanitizeDescriptionHtml } from "./sanitize";
import { fitMetaDescription, sentences } from "./text";

export { fitMetaDescription };
import type { GeneratedRecommendations, SeoPulseInput } from "./types";

/**
 * SeoPulse's final quality gate (D-128): deterministic checks on what a
 * generator wrote, after its one answer and before it is stored — and so
 * before preparation may write it into a listing (D-125). The model is never
 * asked to judge its own answer.
 *
 * Each sentence of the description, each key point, the title and the meta
 * description are checked for:
 *
 *  - sales filler ("Shop today", "Don't miss out") and page furniture
 *    ("Learn more") — removed;
 *  - an evaluative claim the facts do not make ("exceptional cooling",
 *    "lightweight", "clear sound") — removed unless the established facts
 *    themselves use that word; plain factual wording stays;
 *  - a warranty, unless the listing's own manual warranty says there is one;
 *  - text in another language — English only; the product's own names are
 *    not counted as foreign;
 *  - a unit written twice ("2685 MHz MHz") — repaired.
 *
 * Then, across the description: the exact product name is used once (later
 * uses become a shorter name built from the product's identity), a fact
 * already covered twice is not restated in a third sentence, and empty
 * headings and lists are removed. Key points that are only "Label: value" —
 * what At a Glance already shows — are rewritten as a line a shopper reads.
 * The meta description is trimmed at a natural boundary, never mid-word.
 *
 * A field that cannot be repaired is withheld — the description left out, a
 * title or meta description replaced by the rules generator's — rather than
 * written because something had to be. What was removed is reported.
 */

export type QualityReport = { generated: GeneratedRecommendations; repaired: string[]; withheld: string[] };

/** Selling, not describing. Patterns of the genre, not a list of every phrase. */
const SALES_FILLER = [
  /\b(?:buy|order|shop|get|grab|add)\b[^.!?]{0,30}\b(?:now|today|yours)\b/i,
  /\bdon'?t miss(?: out)?\b/i,
  /\b(?:hurry|act fast|limited time|while (?:stocks?|supplies) last)\b/i,
  /\bexperience the difference\b/i,
  /\b(?:make|making) (?:an |the )?(?:informed|smart|right) (?:decision|choice)s?\b/i,
  /\bperfect (?:for|gift for) (?:everyone|anyone|all)\b/i,
  /\bupgrade your\b[^.!?]{0,40}\btoday\b/i,
  /\b(?:you won'?t regret|look no further|say goodbye to|take your \w+ to the next level|elevate your|unleash)\b/i,
  /\b(?:learn more|read more|shop now|buy now|click here|see details|find out more|get educated)\b/i,
  // A sentence that opens by telling the reader to experience or discover
  // something is selling, not describing ("Experience the power of …").
  /^\W*(?:experience|discover|unlock|feel)\s+(?:the|a|an|true|real|what|how|all|every|new|next)\b/i,
];

/**
 * Words that judge rather than state. Each is allowed only where the product's
 * established facts use it themselves: "lightweight" is fine for a product
 * whose facts say "Lightweight design", and withheld for one that only has a
 * weight.
 */
const EVALUATIVE = [
  "amazing", "exceptional", "outstanding", "incredible", "incredibly", "remarkable", "remarkably", "revolutionary",
  "unmatched", "unparalleled", "unbeatable", "unrivaled", "unrivalled", "superior", "superb", "stunning", "impressive",
  "exquisite", "flawless", "perfect", "perfectly", "ultimate", "premium", "luxurious", "luxury", "world-class",
  "best-in-class", "best", "finest", "top-notch", "cutting-edge", "state-of-the-art", "game-changing", "powerful",
  "lightweight", "portable", "comfortable", "comfort", "precise", "precision", "accurate", "accuracy", "responsive",
  "versatile", "convenient", "durable", "long-lasting", "robust", "sturdy", "reliable", "effortless",
  "effortlessly", "seamless", "seamlessly", "immersive", "crystal-clear", "crisp", "rich", "vibrant", "smooth",
  "ultra-smooth", "blazing", "lightning-fast", "fast", "faster", "fastest", "quiet", "sleek", "stylish", "elegant",
  "beautiful", "gorgeous", "innovative", "advanced", "enhanced", "optimal", "ideal", "exclusive", "unique",
  "clear sound", "high-quality", "high quality", "top quality", "professional-grade", "pro-level",
  "high-performance", "high-end", "top-tier", "next-level", "next-gen", "flagship",
];
// "smooth" also catches "smoothly": the adverb makes the same claim.
const EVALUATIVE_PATTERN = new RegExp(`\\b(?:(?:${EVALUATIVE.map((word) => word.replace(/[-\s]/g, "[-\\s]?")).join("|")})(?:ly)?|ultra-\\w+|super-\\w+|most \\w+|least \\w+)\\b`, "gi");

type Context = {
  plan: ContentPlan;
  /** Everything established, lower-cased, that an evaluative word may be found in. */
  factText: string;
  /** Names that are not evidence of a language: brand, model, title words. */
  names: string[];
  manualWarranty: boolean;
};

function contextFor(input: SeoPulseInput): Context {
  const plan = contentPlan(input);
  const factText = [
    ...plan.facts.flatMap((row) => [row.label, row.value]),
    ...(input.knowledge?.attributes ?? []).flatMap((attribute) => [attribute.label, attribute.value]),
    ...(input.pulseWritten?.bulletFeatures ? [] : input.bulletFeatures),
    input.pulseWritten?.description ? "" : input.descriptionText,
    input.title,
    // A brand or model may carry a word that elsewhere would be praise ("Advanced …").
    input.brand ?? "",
    input.knowledge?.brand ?? "",
    input.knowledge?.modelName ?? "",
  ]
    .join(" \n ")
    .toLowerCase();
  const names = [input.title, input.brand ?? "", input.knowledge?.brand ?? "", input.knowledge?.modelName ?? "", ...plan.shortNames].filter(Boolean);
  return { plan, factText, names, manualWarranty: Boolean(input.warranty?.hasWarranty) };
}

/** The first evaluative word in the text that the established facts do not use themselves, or null. */
function unsupportedClaim(text: string, factText: string): string | null {
  const inFacts = factText.replace(/[-\s]+/g, " ");
  for (const match of text.matchAll(EVALUATIVE_PATTERN)) {
    const word = match[0].toLowerCase().replace(/[-\s]+/g, " ");
    const stem = word.replace(/(?:ly|er|est)$/, "");
    if (!inFacts.includes(word) && !(stem.length >= 4 && inFacts.includes(stem))) return match[0];
  }
  return null;
}

/** Why a sentence or line cannot be kept, or null. */
export function sentenceProblem(sentence: string, context: Pick<Context, "factText" | "names" | "manualWarranty">): string | null {
  const text = sentence.trim();
  if (!text) return null;
  if (SALES_FILLER.some((pattern) => pattern.test(text))) return "sales filler";
  if (mentionsWarranty(text) && !context.manualWarranty) return "a warranty the listing does not state";
  const language = textLanguage(text, context.names);
  if (language.nonLatin > 0.3 || (language.evidence >= 3 && language.language !== "en" && language.share >= 0.6)) return "not English";
  const claim = unsupportedClaim(text, context.factText);
  if (claim) return `an unsupported claim ("${claim}")`;
  return null;
}

/**
 * Words after which the praise cannot simply go: one half of a pair
 * ("compact yet powerful") or a degree that needs its adjective ("a more
 * immersive experience" is not "a more experience").
 */
const JOINERS = new Set([
  "and", "or", "nor", "but", "yet", "so",
  "more", "less", "very", "truly", "really", "extremely", "highly", "quite", "even", "too", "incredibly", "super",
]);

/**
 * A sentence whose only fault is praise used as an adjective, with the praise
 * taken out: "It is a high-performance graphics card" → "It is a graphics
 * card". Only a word that sits in front of another word and is not one half
 * of a pair ("clear and immersive visuals") is removed, and "a"/"an" is put
 * right. Null when the sentence has another fault, when a word cannot be
 * taken out that way ("It is exceptional."), or when too little is left —
 * the sentence is then dropped as before. Dropping the whole sentence for one
 * adjective lost the one that named the product.
 */
export function withoutPraise(sentence: string, context: Pick<Context, "factText" | "names" | "manualWarranty">): string | null {
  let text = sentence;
  for (let guard = 0; guard < 6; guard++) {
    const problem = sentenceProblem(plain(text), context);
    if (!problem) return plain(text).split(/\s+/).length >= 4 ? text : null;
    if (!problem.startsWith("an unsupported claim")) return null;
    const claim = unsupportedClaim(text, context.factText);
    if (!claim || /^(?:most|least)\s/i.test(claim)) return null;
    const pattern = new RegExp(`(^|[\\s>(])(?:(\\S+)(\\s+))?${escapeRegExp(claim)}\\s+(?=[A-Za-z0-9])`, "i");
    const match = pattern.exec(text);
    const previous = match?.[2] ?? "";
    if (!match || JOINERS.has(previous.toLowerCase()) || /[,;]$/.test(previous)) return null;
    let next = text.slice(match.index + match[0].length);
    // Followed by a pair word or a preposition, the praise is the point of the
    // phrase ("Perfect for 4K gaming" → "For 4K gaming" is not a sentence).
    if (/^(?:and|or|nor|but|yet|for|to|with|in|on|at|of|from|as|than)\b/i.test(next)) return null;
    let before = text.slice(0, match.index) + match[1] + previous + (match[3] ?? "");
    if (!plain(before)) next = next.charAt(0).toUpperCase() + next.slice(1);
    // "an exceptional card" → "a card"; "a ultra…" never arises.
    before = before.replace(/\b(a|an)(\s+)$/i, (_all, article: string, space: string) => {
      const vowel = /^[aeiou]/i.test(next);
      const fixed = vowel ? "an" : "a";
      return (article[0] === "A" ? fixed[0].toUpperCase() + fixed.slice(1) : fixed) + space;
    });
    text = before + next;
  }
  return null;
}

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether simple description HTML opens and closes every element it uses, in order. */
export function wellFormed(html: string): boolean {
  const stack: string[] = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z0-9]+)>/gi)) {
    const tag = name.toLowerCase();
    if (tag === "br") continue;
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

/**
 * The description, checked sentence by sentence. Null when nothing worth
 * publishing is left, or the markup cannot be trusted.
 */
function gateDescription(html: string, context: Context, repaired: string[]): string | null {
  let clean = sanitizeDescriptionHtml(collapseRepeatedUnits(html));
  if (!wellFormed(clean)) return null;

  const dropped: string[] = [];
  clean = clean.replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (_whole, tag: string, inner: string) => {
    const kept = sentences(inner).flatMap((sentence) => {
      const problem = sentenceProblem(plain(sentence), context);
      if (!problem) return [sentence];
      dropped.push(problem);
      const mended = withoutPraise(sentence, context);
      return mended ? [mended] : [];
    });
    return kept.length ? `<${tag}>${kept.join(" ")}</${tag}>` : "";
  });

  // The exact name once; later uses become a shorter name from the product's own identity.
  const exact = context.plan.exactName;
  const short = context.plan.shortNames[0];
  if (exact.length >= 6) {
    let seen = 0;
    const before = clean;
    clean = clean.replace(new RegExp(escapeRegExp(exact), "gi"), (match) => {
      seen += 1;
      return seen === 1 || !short ? match : short;
    });
    if (clean !== before) repaired.push("the full product name repeated in the description");
  }

  // A fact already stated twice is not stated a third time.
  const covered = new Map<string, number>();
  clean = clean.replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (_whole, tag: string, inner: string) => {
    const kept = sentences(inner).filter((sentence) => {
      const lower = plain(sentence).toLowerCase();
      const mentioned = context.plan.facts.map((row) => row.value.toLowerCase()).filter((value) => value.length >= 3 && lower.includes(value));
      if (mentioned.length === 0) return true;
      const fresh = mentioned.some((value) => (covered.get(value) ?? 0) < 2);
      for (const value of mentioned) covered.set(value, (covered.get(value) ?? 0) + 1);
      if (!fresh) dropped.push("a fact repeated a third time");
      return fresh;
    });
    return kept.length ? `<${tag}>${kept.join(" ")}</${tag}>` : "";
  });

  // Empty lists, and headings with nothing under them.
  for (let pass = 0; pass < 3; pass++) {
    clean = clean
      .replace(/<(ul|ol)>\s*<\/\1>/g, "")
      .replace(/<(h2|h3)>[\s\S]*?<\/\1>\s*(?=<h[23]>|$)/g, "")
      .trim();
  }
  if (dropped.length) repaired.push(...[...new Set(dropped)].map((reason) => `description: ${reason}`));
  const words = plain(clean).split(/\s+/).filter(Boolean).length;
  // At least one real sentence; a short description of a simple product is fine.
  return words >= 5 && wellFormed(clean) ? clean : null;
}

/** Terms: English, no warranty, no unsupported praise ("high end"), no doubled units; the product's own names always pass. */
function gateTerms(terms: string[], context: Context): string[] {
  return terms
    .map((term) => collapseRepeatedUnits(term))
    .filter((term) => {
      if (mentionsWarranty(term) && !context.manualWarranty) return false;
      if (unsupportedClaim(term, context.factText)) return false;
      const language = textLanguage(term, context.names);
      return language.nonLatin <= 0.3;
    });
}

export function applyQualityGate(
  generated: GeneratedRecommendations,
  input: SeoPulseInput,
  fallback: () => GeneratedRecommendations,
): QualityReport {
  const context = contextFor(input);
  const out: GeneratedRecommendations = structuredClone(generated);
  const repaired: string[] = [];
  const withheld: string[] = [];

  // Description.
  if (out.description.suggestedHtml) {
    const gated = gateDescription(out.description.suggestedHtml, context, repaired);
    if (!gated) withheld.push("description");
    out.description.suggestedHtml = gated;
  }

  // Key points: a line a shopper reads, one fact each, never At a Glance again.
  // An At a Glance quantity repeated bare as a key point ("66g ±3g Variance")
  // is that fact without its label: a number that says nothing about what it
  // measures. The same fact explained ("66g weight"), or a value that names
  // itself ("Bluetooth 5.4"), is a key point.
  const glanceForms = new Set(
    context.plan.atAGlance.filter((row) => /^[\s±~≈<>]*\p{N}/u.test(row.value)).map((row) => labelKey(row.value)),
  );
  const points: string[] = [];
  for (const line of out.keyFeatures) {
    const text = stripDecoration(collapseRepeatedUnits(line)).trim();
    if (!text) continue;
    if (sentenceProblem(text, context)) {
      repaired.push(`key point removed: ${sentenceProblem(text, context)}`);
      continue;
    }
    const pair = labelValueLine(text);
    // Any "Label: value" line, not only one whose label matches a fact's:
    // "Memory: 12GB GDDR7" read the same when the facts said "Memory Size".
    const rewritten = pair ? keyPointFromFact(pair.label, pair.value) : text;
    if (rewritten && glanceForms.has(labelKey(rewritten))) {
      repaired.push("key point repeating At a Glance");
      continue;
    }
    if (rewritten && !points.some((point) => labelKey(point) === labelKey(rewritten))) points.push(rewritten);
  }
  if (points.length < out.keyFeatures.length) repaired.push("key points");
  out.keyFeatures = points.slice(0, 8);

  // Title.
  const title = collapseRepeatedUnits(out.seoTitle.recommended);
  const repeatedWord = Object.values(
    labelKey(title)
      .split(" ")
      .filter((word) => word.length > 2)
      .reduce<Record<string, number>>((counts, word) => ({ ...counts, [word]: (counts[word] ?? 0) + 1 }), {}),
  ).some((count) => count >= 3);
  if (!title || sentenceProblem(title, context) || repeatedWord) {
    out.seoTitle = { ...fallback().seoTitle, alternatives: out.seoTitle.alternatives };
    withheld.push("SEO title");
  } else {
    out.seoTitle.recommended = title;
  }
  out.seoTitle.alternatives = out.seoTitle.alternatives.map(collapseRepeatedUnits).filter((alternative) => !sentenceProblem(alternative, context));

  // Meta description: filtered sentence by sentence, then fitted.
  const metaKept = sentences(collapseRepeatedUnits(out.metaDescription.recommended)).filter((sentence) => !sentenceProblem(sentence, context));
  const identityWords = labelKey(`${input.brand ?? ""} ${input.title}`).split(" ").filter((word) => word.length >= 3);
  let meta = fitMetaDescription(metaKept.join(" "));
  if (meta.length < 50 || !identityWords.some((word) => labelKey(meta).split(" ").includes(word))) {
    meta = fitMetaDescription(fallback().metaDescription.recommended);
    withheld.push("meta description");
  }
  out.metaDescription.recommended = meta;

  out.h1.recommended = collapseRepeatedUnits(out.h1.recommended);
  out.tags = gateTerms(out.tags, context);
  out.searchAliases = gateTerms(out.searchAliases, context);
  out.searchPhrases = gateTerms(out.searchPhrases, context);
  out.synonyms = gateTerms(out.synonyms, context);
  out.relatedTerms = gateTerms(out.relatedTerms, context);
  out.brandVariations = gateTerms(out.brandVariations, context);
  out.imageAlts = out.imageAlts
    .map((alt) => ({ ...alt, altText: collapseRepeatedUnits(alt.altText) }))
    .filter((alt) => !sentenceProblem(alt.altText, context));
  out.faqs = out.faqs.map((faq) =>
    faq.answer && (sentenceProblem(faq.answer, context) || /^(null|none|n\/a|unknown)$/i.test(faq.answer.trim()))
      ? { ...faq, answer: null, needsManualAnswer: true, basis: "The drafted answer said something the verified facts do not support." }
      : faq,
  );

  const notes = [...new Set(withheld)];
  if (notes.length) {
    out.description.improvements = [
      `SeoPulse's quality check withheld: ${notes.join(", ")}.`.slice(0, 300),
      ...out.description.improvements,
    ].slice(0, 10);
  }
  return { generated: out, repaired: [...new Set(repaired)], withheld: notes };
}
