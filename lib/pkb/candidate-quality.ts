import { labelKey } from "./normalize";
import { isWarrantyCandidate } from "./warranty-policy";

/**
 * Whether a label and value read from a page could be a product fact at all
 * (D-128), decided before either becomes a claim or an attribute proposal.
 *
 * A manufacturer's page is mostly not product facts: buttons ("Learn More",
 * "Shop Now"), navigation ("Customer Support"), promotional modules ("Get
 * Educated — Make informed decisions with expert advice. Learn More"),
 * decorative ticks and emoji. The structured readers and the AI-assisted
 * reading both see all of it, and in live acceptance such rows reached the
 * review queue as "specifications".
 *
 * The rules look at the shape of the text, not at any brand, category or
 * product: the vocabulary of page furniture, a label that is a sentence, a
 * value that talks to the reader, a value that is only decoration. They fail
 * conservatively: a short plausible label with a plain value — "Architecture:
 * Blackwell", "Closure: Lace-up", "Concentration: Eau de Parfum" — always
 * passes, numeric or not, and an unfamiliar but plausible label still becomes
 * a proposal for a person to decide. Only what is clearly not a fact is
 * dropped.
 *
 * Nothing is removed from the retrieved document: its text is kept as it was
 * read, for provenance. This decides only what may become candidate
 * knowledge.
 */

export type CandidateRejection = {
  code: "WARRANTY_EXTERNAL" | "SOURCE_NOISE" | "DECORATIVE" | "NOT_A_SPECIFICATION";
  reason: string;
};

/**
 * Pictographs, dingbats and invisible joiners. Technical symbols stay: the
 * degree sign, micro, ohm, plus-minus, multiplication, superscripts, and the
 * trademark, registered and copyright signs (which Unicode counts as
 * pictographs, so they are excluded by name).
 */
const DECORATION = /(?![\u00A9\u00AE\u2122])[\p{Extended_Pictographic}\u2190-\u21FF\u2500-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]/gu;

/** Removes decoration, keeping every technical symbol and all words. */
export function stripDecoration(text: string): string {
  return text.replace(DECORATION, " ").replace(/\s+/g, " ").trim();
}

/** Text with nothing but decoration and punctuation in it. */
export function isDecorationOnly(text: string): boolean {
  return text.trim() !== "" && !/[\p{L}\p{N}]/u.test(stripDecoration(text));
}

/**
 * The words of page furniture. Calls to action — "Learn More", "Shop Now",
 * "Get Educated" — are furniture wherever they stand: as the whole label, as
 * the whole value, or where a value trails off into one. Navigation words that
 * are also ordinary words ("Home", "Share", "Compare") count only as a whole
 * label, so "Intended use: Home" is still a fact.
 */
const CALLS_TO_ACTION = [
  "learn more", "read more", "see more", "view more", "show more", "see details", "view details", "more details",
  "shop now", "buy now", "order now", "shop all", "buy online", "add to cart", "add to bag", "add to basket", "add to wishlist",
  "discover more", "explore more", "get started", "get educated", "find out more", "click here", "tap here",
  "contact us", "contact support", "find a store", "where to buy", "store locator", "sign up", "sign in", "log in",
  "join now", "follow us", "share this", "watch video", "watch now", "back to top", "skip to content",
];
const NAVIGATION = [
  "customer support", "help center", "support center", "discover", "explore", "register", "subscribe",
  "newsletter", "share", "tweet", "pin it", "compare", "download", "downloads", "menu", "home", "next", "previous", "close",
];
const CTA_KEYS = new Set(CALLS_TO_ACTION.map(labelKey));
const LABEL_FURNITURE = new Set([...CALLS_TO_ACTION, ...NAVIGATION].map(labelKey));
const TRAILING_CTA = new RegExp(
  String.raw`(?:^|[\s.!:—–-])(?:${CALLS_TO_ACTION.map((phrase) => phrase.replace(/ /g, String.raw`\s+`)).join("|")})\s*[.!»›>→]*\s*$`,
  "i",
);

/** Speaking to the reader: marketing and help copy, not a specification. */
// "us" only in lower case: "US" is a region, "us" is the page talking.
const ADDRESSES_READER = /\b(?:[Yy]ou|YOU|[Yy]our|YOUR|[Yy]ou're|[Yy]ours|[Ww]e|WE|[Ww]e're|[Oo]ur|OUR)\b|\bus\b/;
/** Selling or teaching rather than stating: "make informed decisions", "don't miss". */
const PERSUASION = /\b(make (?:an )?informed decisions?|expert advice|don'?t miss|limited time|exclusive offer|best deals?|free shipping|sign up for|get (?:yours|it) (?:now|today)|shop the|explore the|discover the|learn how|find out how|click here|tap here)\b/i;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.[\w-]+\.\w/i;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Why this label and value must not become candidate knowledge, or null when
 * it may (as a claim if an attribute names it, otherwise as a proposal).
 */
export function candidateRejection(rawLabel: string, rawValue: string): CandidateRejection | null {
  if (isWarrantyCandidate(rawLabel, rawValue)) {
    return { code: "WARRANTY_EXTERNAL", reason: "Warranty is entered by Manifest staff only; a source's warranty terms are not product knowledge." };
  }
  if (isDecorationOnly(rawLabel) || isDecorationOnly(rawValue)) {
    return { code: "DECORATIVE", reason: "Only decoration (icons, ticks or emoji), no words." };
  }
  const label = stripDecoration(rawLabel);
  const value = stripDecoration(rawValue);
  if (!label || !value) return { code: "DECORATIVE", reason: "Nothing is left once decoration is removed." };

  const labelKeyed = labelKey(label);
  const valueKeyed = labelKey(value);
  if (LABEL_FURNITURE.has(labelKeyed) || CTA_KEYS.has(valueKeyed)) {
    return { code: "SOURCE_NOISE", reason: "A button, link or navigation label, not a product fact." };
  }
  if (TRAILING_CTA.test(value) && words(value) > 1) {
    return { code: "SOURCE_NOISE", reason: "Promotional text ending in a button or link." };
  }
  if (URL_LIKE.test(value) || PERSUASION.test(value) || PERSUASION.test(label)) {
    return { code: "SOURCE_NOISE", reason: "Promotional or navigational text, not a product fact." };
  }

  // A label is a name for a property, not a sentence.
  if (label.length > 60 || words(label) > 8 || /[.!?]\s*$/.test(label) || ADDRESSES_READER.test(label)) {
    return { code: "NOT_A_SPECIFICATION", reason: "The label is a sentence or a heading, not the name of a property." };
  }
  // A heading repeated as its own value says nothing.
  if (labelKeyed === valueKeyed) {
    return { code: "NOT_A_SPECIFICATION", reason: "The value only repeats the label." };
  }
  // Prose addressed to the reader, with no figure in it, is copy, not a value.
  if (ADDRESSES_READER.test(value) && words(value) >= 8 && !/\p{N}/u.test(value)) {
    return { code: "NOT_A_SPECIFICATION", reason: "Marketing or help text addressed to the reader, not a stated value." };
  }
  return null;
}
