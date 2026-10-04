/**
 * English-only research (D-128): what language a retrieved page is in.
 *
 * Manifest reads product facts from English pages only. Evidence a person
 * verifies must be readable as it stands, and a model must never be the
 * translator between a source and a fact. An official page in another
 * language is not eligible, however trusted its domain: official decides
 * whose word it is, not whether the words may be used.
 *
 * Several signals, in order of trust:
 *
 *  1. the visible text itself — the final authority whenever it says enough:
 *     its writing system, and which language's common function words it is
 *     made of;
 *  2. what the page declares (`<html lang>`, a Content-Language header), used
 *     only when the text is too short to decide and never against clear text.
 *
 * No language is guessed. When the signals are too weak or disagree, the
 * verdict is `uncertain`, and an uncertain page is not used for facts
 * (LANGUAGE_UNCERTAIN). A few foreign words — a country picker, a legal line
 * — do not outvote a page written in English.
 */

export type LanguageVerdict = {
  verdict: "english" | "non_english" | "uncertain";
  /** The language or writing system found, as a short code ("en", "de", "ja") or a script name. */
  language: string | null;
  reason: string;
};

/** Writing systems that are not the Latin alphabet, each a clear sign by itself. */
const SCRIPTS: [string, RegExp][] = [
  ["zh", /\p{Script=Han}/gu],
  ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ["ko", /\p{Script=Hangul}/gu],
  ["ar", /\p{Script=Arabic}/gu],
  ["he", /\p{Script=Hebrew}/gu],
  ["ru", /\p{Script=Cyrillic}/gu],
  ["el", /\p{Script=Greek}/gu],
  ["hi", /\p{Script=Devanagari}/gu],
  ["bn", /\p{Script=Bengali}/gu],
  ["th", /\p{Script=Thai}/gu],
  ["ta", /\p{Script=Tamil}/gu],
];

/**
 * The commonest function words of languages written in the Latin alphabet.
 * Short, frequent and mostly unique to their language: product text in any of
 * them is full of these, and a product's own name almost never is.
 */
const FUNCTION_WORDS: Record<string, string[]> = {
  en: ["the", "and", "with", "for", "of", "to", "is", "are", "this", "that", "your", "you", "from", "by", "it", "its", "on", "in", "an", "be", "can", "or", "at", "as", "has", "have", "more", "our", "all", "which", "while", "when", "into", "up"],
  de: ["der", "die", "das", "und", "mit", "für", "ist", "sind", "nicht", "ein", "eine", "einen", "auf", "zu", "von", "dem", "den", "des", "sie", "ihr", "ihre", "auch", "oder", "wird", "werden", "bei", "noch", "nach", "über", "durch"],
  fr: ["le", "la", "les", "et", "avec", "pour", "est", "sont", "une", "des", "du", "dans", "sur", "vous", "votre", "vos", "pas", "qui", "que", "au", "aux", "ce", "cette", "ou", "plus", "par", "sans", "leur", "très"],
  es: ["el", "los", "las", "y", "con", "para", "es", "son", "una", "del", "en", "por", "su", "sus", "que", "sin", "más", "como", "tu", "este", "esta", "pero", "también", "hasta", "desde"],
  it: ["il", "lo", "gli", "le", "e", "con", "per", "è", "sono", "una", "della", "delle", "degli", "nel", "nella", "che", "non", "più", "questo", "questa", "anche", "senza", "tra"],
  pt: ["o", "os", "as", "e", "com", "para", "é", "são", "uma", "do", "da", "dos", "das", "no", "na", "em", "que", "não", "mais", "seu", "sua", "também", "sem"],
  nl: ["de", "het", "een", "en", "met", "voor", "is", "zijn", "van", "op", "niet", "ook", "dat", "die", "je", "jouw", "uw", "bij", "naar", "door", "wordt"],
  sv: ["och", "med", "för", "är", "som", "en", "ett", "på", "av", "till", "inte", "det", "den", "din", "ditt", "har", "från", "eller"],
  da: ["og", "med", "til", "er", "som", "en", "et", "på", "af", "ikke", "det", "den", "din", "dit", "har", "fra", "eller", "også"],
  pl: ["i", "w", "z", "na", "do", "jest", "są", "nie", "się", "dla", "oraz", "że", "od", "po", "przez", "jak", "tak"],
  tr: ["ve", "ile", "için", "bir", "bu", "da", "de", "olan", "daha", "çok", "gibi", "ama", "veya", "en"],
  id: ["dan", "dengan", "untuk", "yang", "ini", "itu", "adalah", "dari", "pada", "tidak", "atau", "juga", "ke", "di"],
};

/** Words shared by several languages count for none of them. */
const SHARED = (() => {
  const seen = new Map<string, number>();
  for (const list of Object.values(FUNCTION_WORDS)) for (const word of new Set(list)) seen.set(word, (seen.get(word) ?? 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([word]) => word));
})();
const WORD_LANGUAGE = new Map<string, string>();
for (const [language, list] of Object.entries(FUNCTION_WORDS)) {
  for (const word of list) if (!SHARED.has(word)) WORD_LANGUAGE.set(word, language);
}

/**
 * Words English product pages are made of when they have little running text
 * — a specification table, a short product card: section names, common
 * properties, page words. Weaker evidence than function words (half each),
 * and counted for English only, so a page in another language with a few
 * English technical terms is still decided by its own function words.
 */
const ENGLISH_PAGE_WORDS = new Set([
  "specifications", "specification", "specs", "features", "feature", "overview", "details", "description", "reviews",
  "review", "support", "technical", "product", "products", "included", "includes", "compatible", "compatibility",
  "dimensions", "weight", "color", "colour", "size", "material", "materials", "battery", "life", "hours", "charging",
  "wireless", "wired", "cable", "headphones", "earbuds", "speaker", "mouse", "keyboard", "gaming", "sensor", "driver",
  "connectivity", "power", "output", "input", "display", "screen", "memory", "storage", "speed", "performance", "design",
  "water", "resistant", "noise", "cancelling", "canceling", "sound", "audio", "light", "black", "white", "blue", "red",
  "green", "silver", "gray", "grey", "skin", "hair", "type", "types", "ingredient", "ingredients", "key", "volume",
  "capacity", "shipping", "cart", "price", "buy", "learn", "more", "about", "manual", "guide", "new", "model", "series",
  "edition", "fit", "sole", "upper", "closure", "scent", "notes", "fragrance", "size", "pack", "count", "brand",
]);

/** At least this many function words before the text itself decides. */
const MIN_EVIDENCE = 8;
/** With less, all of it must agree (a specification table, a short card). */
const MIN_THIN_EVIDENCE = 4;

export type TextLanguage = {
  language: string | null;
  /** Function words found, across all languages. */
  evidence: number;
  /** The leading language's share of them, 0–1. */
  share: number;
  /** Share of letters outside the Latin alphabet, 0–1. */
  nonLatin: number;
  /** How many different words of the leading language were found. */
  distinct: number;
};

/** What the text alone says. Pure. */
export function textLanguage(text: string, ignore: string[] = []): TextLanguage {
  let sample = text.slice(0, 60_000);
  // A product's own name is not evidence of anything ("Die Hard", "Le Creuset").
  for (const name of ignore) {
    if (name.trim().length >= 2) sample = sample.split(name).join(" ");
  }
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return { language: null, evidence: 0, share: 0, nonLatin: 0, distinct: 0 };

  let bestScript: string | null = null;
  let scriptLetters = 0;
  let nonLatinLetters = 0;
  for (const [code, pattern] of SCRIPTS) {
    const count = (sample.match(pattern) ?? []).length;
    nonLatinLetters += count;
    if (count > scriptLetters) {
      scriptLetters = count;
      bestScript = code;
    }
  }
  const nonLatin = nonLatinLetters / letters;
  if (nonLatin > 0.3) return { language: bestScript, evidence: nonLatinLetters, share: scriptLetters / nonLatinLetters, nonLatin, distinct: 0 };

  const counts = new Map<string, number>();
  const distinctWords = new Map<string, Set<string>>();
  let evidence = 0;
  for (const match of sample.matchAll(WORD)) {
    const written = match[0];
    if (isCodeToken(written, sample, match.index)) continue;
    const word = written.toLowerCase();
    const language = WORD_LANGUAGE.get(word) ?? (ENGLISH_PAGE_WORDS.has(word) ? "en" : null);
    if (!language) continue;
    const weight = WORD_LANGUAGE.has(word) ? 1 : 0.5;
    counts.set(language, (counts.get(language) ?? 0) + weight);
    distinctWords.set(language, (distinctWords.get(language) ?? new Set()).add(word));
    evidence += weight;
  }
  const [language, top] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { language, evidence, share: evidence ? top / evidence : 0, nonLatin, distinct: language ? (distinctWords.get(language)?.size ?? 0) : 0 };
}

/** A run of letters that is a word of its own: not part of "i7", "20W" or "x86". */
const WORD = /(?<![\p{L}\p{N}])\p{L}+(?![\p{L}\p{N}])/gu;

/**
 * Whether a run of letters is a unit, a code or an abbreviation rather than a
 * word of a language.
 *
 * Technical values are full of short letter runs that happen to spell another
 * language's function words: "65 W" (Polish "w"), "Bluetooth LE" (French
 * "le"), "Type-C to DE-15" (German "de"… and Dutch), "I/O", "Y-axis". Counted
 * as words, three of them made an English specification "not English". A
 * function word in running text is lower case, or capitalised at the start of
 * a sentence; so:
 *
 *  - two or three capitals ("LE", "DE", "ES", "DIE" as an acronym) are not
 *    words — a heading set in capitals loses a little evidence, the page's
 *    running text keeps all of its own;
 *  - a single letter is a word only when it stands free and in lower case:
 *    not a capital ("W", "V", "I"), and not joined to a figure, a hyphen, a
 *    slash or a plus ("5 w/", "y-axis", "i-Size", "e+").
 */
function isCodeToken(written: string, sample: string, index: number): boolean {
  if (written.length <= 3 && written.length >= 2 && written === written.toUpperCase() && written !== written.toLowerCase()) return true;
  if (written.length !== 1) return false;
  if (written !== written.toLowerCase()) return true;
  const before = sample[index - 1] ?? " ";
  const after = sample[index + 1] ?? " ";
  return /[-/+.\p{N}]/u.test(before) || /[-/+\p{N}]/u.test(after);
}

/** "en", "en-US", "en_GB" → "en". */
export function primaryLanguage(tag: string | null | undefined): string | null {
  const match = /^\s*([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*\s*$/i.exec(tag ?? "");
  return match ? match[1].toLowerCase() : null;
}

/** The first language a Content-Language header or lang attribute names. */
export function declaredLanguage(...tags: (string | null | undefined)[]): string | null {
  for (const tag of tags) {
    const first = (tag ?? "").split(",")[0];
    const primary = primaryLanguage(first);
    if (primary) return primary;
  }
  return null;
}

/** `<html lang="…">` (or `xml:lang`), when the page declares one. */
export function htmlLanguage(html: string): string | null {
  const tag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  const lang = /\b(?:xml:)?lang\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(tag);
  return lang ? lang[1] : null;
}

/**
 * The page's language verdict, from its visible text and what it declares.
 * `ignore` is the product's own naming, which is not evidence either way.
 */
export function detectLanguage(input: { text: string; declared?: (string | null | undefined)[]; ignore?: string[] }): LanguageVerdict {
  const found = textLanguage(input.text, input.ignore);
  const declared = declaredLanguage(...(input.declared ?? []));

  if (found.nonLatin > 0.3) {
    return { verdict: "non_english", language: found.language, reason: `The page is written in a non-Latin script (${found.language}).` };
  }
  if (found.evidence >= MIN_EVIDENCE) {
    const english = found.language === "en";
    // Clear text decides. A page declared as another language needs text that
    // is overwhelmingly English before the declaration is called wrong.
    if (english && found.share >= 0.6 && (declared === null || declared === "en" || (found.share >= 0.8 && found.evidence >= 20))) {
      return { verdict: "english", language: "en", reason: "The page's text is English." };
    }
    if (!english && found.share >= 0.5) {
      return { verdict: "non_english", language: found.language, reason: `The page's text is ${found.language}, not English.` };
    }
    if (english && found.share >= 0.6 && declared && declared !== "en") {
      return { verdict: "non_english", language: declared, reason: `The page declares ${declared} and its text is not clearly English.` };
    }
    return { verdict: "uncertain", language: null, reason: "The page's text mixes languages; which one it is written in cannot be told with confidence." };
  }
  /*
   * Little running text — a specification table, a short product card. Its
   * few words still decide when they all point one way and nothing declared
   * says otherwise; a mixture, or a contradicting declaration, does not.
   */
  if (found.evidence >= MIN_THIN_EVIDENCE && found.share >= 0.9) {
    if (found.language === "en" && (declared === null || declared === "en")) {
      return { verdict: "english", language: "en", reason: "The page's few words are all English." };
    }
    if (found.language !== "en" && (declared === null || declared === found.language)) {
      return { verdict: "non_english", language: found.language, reason: `The page's few words are ${found.language}.` };
    }
  }
  if (declared === "en") return { verdict: "english", language: "en", reason: "The page declares English and its text does not contradict it." };
  if (declared) return { verdict: "non_english", language: declared, reason: `The page declares ${declared}.` };
  return { verdict: "uncertain", language: null, reason: "The page declares no language and has too little text to tell." };
}

/** Whether a locale tag is English ("en", "en-US", "en_gb"). */
export function isEnglishTag(tag: string | null | undefined): boolean {
  return primaryLanguage(tag) === "en";
}

/**
 * English versions this page says it has: `<link rel="alternate"
 * hreflang="en…" href="…">`, resolved against the page's address. `x-default`
 * is not taken as English. Bounded: a handful at most.
 */
export function englishAlternates(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
    const hreflang = /\bhreflang\s*=\s*["']?([A-Za-z_-]+)/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!hreflang || !href || !isEnglishTag(hreflang)) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), pageUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      url.hash = "";
      // Prefer the plain "en" and the US version, as Manifest buys from the US.
      const rank = /^en[-_]us$/i.test(hreflang) ? 0 : /^en$/i.test(hreflang) ? 1 : 2;
      found.push(`${rank}|${url.toString()}`);
    } catch {
      continue;
    }
  }
  return [...new Set(found.sort().map((entry) => entry.slice(2)))].filter((url) => url !== pageUrl).slice(0, 3);
}

/**
 * The locale an address names in its path or host, if it names one:
 * "/de/…", "/fr-fr/…", "/ja_JP/…", "de.example.com". Only a hint for ranking
 * search results — an address alone never proves what language a page is in.
 */
export function urlLocale(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  for (const segment of url.pathname.split("/").slice(1, 3)) {
    const match = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i.exec(segment);
    if (match && (KNOWN_LANGUAGES.has(match[1].toLowerCase()) || match[2]?.toLowerCase() === "en")) return segment.toLowerCase().replace("_", "-");
  }
  const sub = /^([a-z]{2})\./i.exec(url.hostname)?.[1]?.toLowerCase();
  if (sub && sub !== "www" && KNOWN_LANGUAGES.has(sub)) return sub;
  const query = url.searchParams.get("lang") ?? url.searchParams.get("locale") ?? url.searchParams.get("hl");
  return query && primaryLanguage(query) ? query.toLowerCase() : null;
}

/** ISO 639-1 codes likely to appear as a locale segment; "us" and "uk" are countries, and English. */
const KNOWN_LANGUAGES = new Set([
  "en", "de", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "nb", "fi", "pl", "cs", "sk", "hu", "ro", "tr", "el", "ru", "uk",
  "ja", "zh", "ko", "ar", "he", "hi", "bn", "th", "vi", "id", "ms", "ta", "us", "gb", "au", "ca",
]);
const ENGLISH_REGIONS = new Set(["us", "gb", "uk", "au", "ca", "en"]);

/** Search ranking: an address that names English (or an English-speaking market) first, one naming another language last. */
export function urlLanguagePreference(raw: string): number {
  const locale = urlLocale(raw);
  if (!locale) return 0;
  const [first, second] = locale.split("-");
  // "en-gb", and the country-first "gb-en" or "sg-en" some manufacturers use (D-129, found live).
  if (first === "en" || second === "en" || (ENGLISH_REGIONS.has(first) && !second)) return 1;
  return -1;
}

/** `inLanguage` from a page's structured data (schema.org), when it states one. */
export function structuredDataLanguage(structuredData: unknown[]): string | null {
  const stack: unknown[] = [...structuredData];
  for (let seen = 0; stack.length > 0 && seen < 500; seen++) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const value = (item as Record<string, unknown>).inLanguage;
    if (typeof value === "string" && primaryLanguage(value)) return value;
    stack.push(...Object.values(item as Record<string, unknown>));
  }
  return null;
}
