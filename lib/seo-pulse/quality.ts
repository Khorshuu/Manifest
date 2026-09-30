import { labelKey } from "@/lib/pkb/normalize";
import { textLanguage } from "@/lib/pkb/language";
import { stripDecoration } from "@/lib/pkb/candidate-quality";
import { collapseRepeatedUnits } from "@/lib/pkb/unit-text";
import { mentionsWarranty } from "@/lib/pkb/warranty-policy";
import { EVALUATIVE_PATTERN } from "./claim-words";
import { contentPlan, keyPointFromFact, labelValueLine, openingSentence, type ContentPlan } from "./content-plan";
import { sanitizeDescriptionHtml } from "./sanitize";
import { escapeHtml, fitMetaDescription, sentences } from "./text";
import { fitSeoTitle, titleIdentity } from "./title-fit";

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

type Context = {
  plan: ContentPlan;
  /** Everything established, lower-cased, that an evaluative word may be found in. */
  factText: string;
  /** Names that are not evidence of a language: brand, model, title words. */
  names: string[];
  manualWarranty: boolean;
  brand: string;
  /** Words of the established facts and of the product's brand and model: what a clause needs one of to say something. */
  substance: Set<string>;
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
  const brand = (input.knowledge?.brand ?? input.brand ?? "").trim();
  const substance = new Set(
    labelKey([...plan.facts.flatMap((row) => [row.label, row.value]), brand, input.knowledge?.modelName ?? "", input.details?.modelName ?? ""].join(" "))
      .split(" ")
      .filter((word) => word.length >= 3),
  );
  return { plan, factText, names, manualWarranty: Boolean(input.warranty?.hasWarranty), brand, substance };
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

/*
 * Sentences with nothing to say (D-129). Taking praise out can leave "it
 * delivers performance": grammatical, true, and empty. A sentence is thin
 * when, apart from grammar, it is made only of a generic subject ("it",
 * "users"), a generic verb ("delivers", "offers", "designed") and a generic
 * noun ("performance", "quality", "experience"), and has no figure. These are
 * word classes, not a list of phrases: any other word — "cooler", "rosewater",
 * "Bluetooth" — is something said, and the sentence stays.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "with", "in", "on", "at", "by", "from", "as", "into", "is", "are",
  "was", "be", "been", "being", "has", "have", "had", "can", "will", "also", "all", "any", "each", "every", "very",
  "more", "so", "just", "while", "our", "s",
]);
const GENERIC_SUBJECT = new Set([
  "it", "its", "this", "that", "these", "those", "they", "them", "their", "you", "your", "user", "users", "people",
  "everyone", "anyone", "one", "product", "item", "device", "unit", "option", "choice", "solution",
]);
const GENERIC_VERB =
  /^(?:deliver|provide|offer|give|bring|ensure|enable|allow|let|help|make|made|create|feature|boast|promise|serve|design|built|build|craft|engineer|suit|use|work|ideal|suitable|great|good)(?:s|es|ed|d|ing)?$/;
const GENERIC_NOUN =
  /^(?:performance|quality|functionality|function|functions|experience|experiences|result|results|value|usage|need|needs|power|reliability|satisfaction|convenience|capability|capabilities|feature|features|benefit|benefits|everyday|daily|life|lifestyle|style|purpose|purposes|task|tasks|application|applications|use|uses)$/;

function contentWords(text: string): string[] {
  return labelKey(text)
    .split(" ")
    .filter((word) => word && !FUNCTION_WORDS.has(word) && !GENERIC_SUBJECT.has(word) && !GENERIC_VERB.test(word) && !GENERIC_NOUN.test(word));
}

/** A sentence that says nothing: no figure, and nothing but generic words. */
export function thinSentence(text: string): boolean {
  return !/\p{N}/u.test(text) && contentWords(text).length === 0;
}

/**
 * A clause praise was taken out of, judged more strictly: a generic verb with
 * at most one other word and no established fact ("delivers graphics", once
 * "high-performance" went) said only the praise, so it goes too.
 */
function thinClause(text: string, context: Pick<Context, "substance">): boolean {
  if (thinSentence(text)) return true;
  if (/\p{N}/u.test(text)) return false;
  const all = labelKey(text).split(" ");
  const content = contentWords(text);
  return all.some((word) => GENERIC_VERB.test(word)) && content.length <= 1 && !content.some((word) => context.substance.has(word));
}

/*
 * A generic predicate left behind by praise removal (D-129A). "delivers
 * exceptional performance" loses "exceptional" and becomes "delivers
 * performance": a generic verb whose object is only generic nouns. The clause
 * around it may carry a figure or a real fact ("… memory and delivers
 * performance for 4K gaming"), which kept the whole clause before; now the
 * predicate itself is found and taken out, with what depended on it, and the
 * rest of the sentence stays. Nothing is put in its place.
 */
const PREDICATE_VERB =
  /^(?:deliver|provide|offer|give|bring|ensure|enable|guarantee|boast|promise|maximi[sz]e|improve|enhance|boost|elevate)(?:s|es|ed|d)?$/;
/** Nouns that say nothing on their own, as the object of such a verb. */
const EMPTY_OBJECT = (word: string) => GENERIC_NOUN.test(word) || /^(?:stability|efficiency|productivity|possibilities)$/.test(word);
const DETERMINER = new Set(["a", "an", "the", "its", "their", "your", "our", "this", "that", "more"]);
/** Words after which the rest of the clause only said what the predicate was for. */
const COMPLEMENT_START = new Set(["for", "in", "during", "across", "when", "while", "with", "at", "on", "under", "to", "from", "throughout"]);
const INTRO_ONLY = /^\W*(?:with|for|thanks to|featuring|from|at|in|by|through|using)\b/i;

function predicateVerb(word: string): boolean {
  // "delivering", "providing", "ensuring": the -ing form of a verb ending in e drops it.
  return PREDICATE_VERB.test(word) || (/ing$/.test(word) && (PREDICATE_VERB.test(word.slice(0, -3)) || PREDICATE_VERB.test(`${word.slice(0, -3)}e`)));
}

type Token = { text: string; lower: string; start: number; end: number };

/** The span of the first generic predicate in the tokens, with what depends on it; null when there is none. */
function genericPredicateSpan(tokens: Token[]): { from: number; to: number } | null {
  for (let verb = 0; verb < tokens.length; verb++) {
    if (!predicateVerb(tokens[verb].lower)) continue;
    // The object: optional determiners, then only generic nouns joined by "and" or commas.
    const skipDeterminers = (index: number) => {
      while (index < tokens.length && DETERMINER.has(tokens[index].lower)) index++;
      return index;
    };
    let at = skipDeterminers(verb + 1);
    let last = -1;
    while (at < tokens.length && EMPTY_OBJECT(tokens[at].lower)) {
      last = at;
      const joiner = tokens[at + 1]?.lower;
      at = joiner === "and" || joiner === "," ? skipDeterminers(at + 2) : at + 1;
    }
    if (last === -1) continue;
    // "performance of 2685 MHz" is a measured quantity, not an empty claim.
    const after = tokens[last + 1];
    if (after?.lower === "of" && /\p{N}/u.test(tokens[last + 2]?.text ?? "")) continue;
    // What the predicate was for goes with it, to the end of the clause.
    let to = last;
    if (after && COMPLEMENT_START.has(after.lower)) {
      to = last + 1;
      while (to + 1 < tokens.length && tokens[to + 1].lower !== "," && tokens[to + 1].lower !== ";") to++;
    }
    // Where it starts depends on what comes before the verb.
    const before = tokens[verb - 1]?.lower;
    let from: number;
    if (before === "to") {
      from = verb - 1;
      if (tokens[from - 1] && /^(?:help|helps|helping|order)$/.test(tokens[from - 1].lower)) from -= tokens[from - 2]?.lower === "in" ? 2 : 1;
    } else if (before === "and" || before === "or" || before === "which" || before === "that") {
      from = verb - 1;
    } else if (before === "," || before === ";") {
      from = verb - 1;
    } else {
      // A subject before it: the whole clause goes ("…, this card delivers performance for …").
      from = verb;
      while (from > 0 && tokens[from - 1].lower !== "," && tokens[from - 1].lower !== ";") from--;
    }
    if (from > 0 && tokens[from - 1].lower === ",") from--;
    return { from, to };
  }
  return null;
}

/**
 * A sentence praise was taken out of, without the generic predicates that
 * praise leaves behind: "The card uses 12GB GDDR7 memory and delivers
 * performance." → "The card uses 12GB GDDR7 memory."; "… cooling system to
 * ensure performance and stability." → "… cooling system.". Null when what is
 * left is not a sentence — empty, too short, or only an introductory phrase
 * ("With a boost clock of 2685 MHz.") — so the sentence is dropped.
 */
export function withoutGenericPredicates(sentence: string): string | null {
  let text = sentence;
  for (let guard = 0; guard < 4; guard++) {
    const tokens: Token[] = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]|[,;]/gu)].map((match) => ({
      text: match[0],
      lower: match[0].toLowerCase(),
      start: match.index!,
      end: match.index! + match[0].length,
    }));
    const span = genericPredicateSpan(tokens);
    if (!span) break;
    const end = /([.!?])["”)]?\s*$/.exec(text)?.[1] ?? ".";
    let out = (text.slice(0, tokens[span.from].start) + text.slice(tokens[span.to].end)).replace(/\s+([,;.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
    out = out.replace(/^[\s,;]+/, "").replace(/[\s,;]+(?=[.!?]?$)/, "");
    if (!/[.!?]["”)]?$/.test(out)) out = out.replace(/[.!?]*$/, "") + end;
    if (out && /^\p{Ll}/u.test(out) && /^\p{Lu}/u.test(text.trim())) out = out.charAt(0).toUpperCase() + out.slice(1);
    text = out;
  }
  const words = plain(text).split(/\s+/).filter(Boolean);
  if (words.length < 4 || thinSentence(plain(text))) return null;
  if (INTRO_ONLY.test(plain(text)) && !/[,;]/.test(plain(text))) return null;
  return text;
}

const CLAUSE_BREAK = /(,\s+|;\s+|\s+(?:and|while|but|whereas)\s+)/i;

/**
 * A sentence after `withoutPraise`, with any clause the praise was taken out
 * of dropped when that left it empty: "The card uses 12GB GDDR7 memory and
 * delivers high-performance graphics." → "The card uses 12GB GDDR7 memory."
 * The factual clause stays. Null when the first clause is the empty one.
 */
function withoutThinClauses(original: string, mended: string, context: Pick<Context, "substance">): string | null {
  const before = original.split(CLAUSE_BREAK);
  const after = mended.split(CLAUSE_BREAK);
  if (before.length !== after.length || after.length === 1) return thinClause(plain(mended), context) ? null : mended;
  let out = "";
  for (let index = 0; index < after.length; index += 2) {
    const changed = plain(before[index]) !== plain(after[index]);
    if (changed && thinClause(plain(after[index]), context)) {
      if (index === 0) return null;
      continue;
    }
    out += index === 0 ? after[0] : after[index - 1] + after[index];
  }
  const end = /([.!?])["”)]?\s*$/.exec(mended)?.[1] ?? ".";
  out = out.replace(/[\s,;]+$/, "");
  if (!/[.!?]["”)]?$/.test(out)) out += end;
  return plain(out).split(/\s+/).length >= 4 ? out : null;
}

/**
 * Whether a sentence says which product this is: the exact name, a short name
 * from the plan, or the brand with a word only this product's name has.
 */
function namesProduct(text: string, context: Context): boolean {
  const said = ` ${labelKey(text)} `;
  const names = [context.plan.exactName, ...context.plan.shortNames].map(labelKey).filter((name) => name.length >= 3);
  if (names.some((name) => said.includes(` ${name} `))) return true;
  const nameWords = labelKey(context.plan.exactName).split(" ").filter(Boolean);
  const brandWords = labelKey(context.brand).split(" ").filter(Boolean);
  const titleWords = nameWords.filter((word) => !brandWords.includes(word));
  const distinctive = [titleWords[0], ...titleWords.filter((word) => /\p{N}/u.test(word))].filter(Boolean);
  // A brand the name does not carry ("Soundcore …" sold by its parent brand) is not required.
  const brandInName = brandWords.length > 0 && brandWords.every((word) => nameWords.includes(word));
  const brandSaid = !brandInName || brandWords.every((word) => said.includes(` ${word} `));
  return brandSaid && distinctive.some((word) => said.includes(` ${word} `));
}

/** Empty lists, and headings with nothing under them. */
function withoutEmptyStructure(html: string): string {
  let clean = html;
  for (let pass = 0; pass < 3; pass++) {
    clean = clean
      .replace(/<(ul|ol)>\s*<\/\1>/g, "")
      .replace(/<(h2|h3)>[\s\S]*?<\/\1>\s*(?=<h[23]>|$)/g, "")
      .trim();
  }
  return clean;
}

function wordCount(html: string): number {
  return plain(html).split(/\s+/).filter(Boolean).length;
}

/**
 * The description, checked sentence by sentence. Null when nothing worth
 * publishing is left, or the markup cannot be trusted.
 */
function gateDescription(html: string, context: Context, repaired: string[]): string | null {
  let clean = sanitizeDescriptionHtml(collapseRepeatedUnits(html));
  if (!wellFormed(clean)) return null;

  const dropped: string[] = [];
  const report = () => {
    if (dropped.length) repaired.push(...[...new Set(dropped)].map((reason) => `description: ${reason}`));
  };
  clean = clean.replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (_whole, tag: string, inner: string) => {
    const kept = sentences(inner).flatMap((sentence) => {
      const problem = sentenceProblem(plain(sentence), context);
      if (!problem) {
        // Nothing wrong with it, and nothing in it (D-129).
        if (thinSentence(plain(sentence))) {
          dropped.push("a sentence with nothing to say");
          return [];
        }
        return [sentence];
      }
      dropped.push(problem);
      const mended = withoutPraise(sentence, context);
      const residueFree = mended ? withoutGenericPredicates(mended) : null;
      const mendedKept = residueFree ? withoutThinClauses(sentence, residueFree, context) : null;
      if (mended && !mendedKept) dropped.push("a sentence with nothing to say once the praise was taken out");
      return mendedKept ? [mendedKept] : [];
    });
    return kept.length ? `<${tag}>${kept.join(" ")}</${tag}>` : "";
  });
  clean = withoutEmptyStructure(clean);
  // At least one real sentence of the generator's own; a short description of a simple product is fine.
  if (wordCount(clean) < 5) {
    report();
    return null;
  }

  /*
   * The description names the product in its first sentence (D-129). When
   * the opening was dropped — or never named the product — and the sentence
   * now first ("It connects over …") does not say which product this is, a
   * plain opening built from the name and established facts goes first. No
   * second model call, and nothing the facts do not say.
   */
  const first = [...clean.matchAll(/<(p|li)>([\s\S]*?)<\/\1>/g)].flatMap((match) => sentences(match[2]))[0] ?? "";
  if (!namesProduct(plain(first), context)) {
    const candidates = [openingSentence(context.plan), context.plan.exactName.trim() ? `This is the ${context.plan.exactName.trim()}.` : ""];
    const intro = candidates.find((candidate) => candidate && !sentenceProblem(candidate, context));
    if (intro) {
      clean = clean.startsWith("<p>") ? clean.replace(/^<p>/, `<p>${escapeHtml(intro)} `) : `<p>${escapeHtml(intro)}</p>${clean}`;
      repaired.push("description: a plain opening naming the product");
    }
  }

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

  clean = withoutEmptyStructure(clean);
  report();
  return wordCount(clean) >= 5 && wellFormed(clean) ? clean : null;
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
  const title = fitSeoTitle(collapseRepeatedUnits(out.seoTitle.recommended), titleIdentity(input));
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
