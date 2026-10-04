import type {
  GeneratedRecommendations,
  KeywordRecommendation,
  SeoPulseInput,
  SeoResearchData,
} from "./types";
import { knowledgeSufficiency, measurementRows, specificationRows } from "./facts";
import { factMetaSentence, factParagraph, keyPointFromFact, prioritizedFacts } from "./content-plan";
import { labelKey } from "@/lib/pkb/normalize";
import { EVALUATIVE_PATTERN } from "./claim-words";
import { textLanguage } from "@/lib/pkb/language";
import { mentionsWarranty } from "@/lib/pkb/warranty-policy";
import { fitSeoTitle, SITE_TITLE_SUFFIX, titleIdentity } from "./title-fit";
import { isIdentityLabel, isIdentityLine, isStrongModelKey, variantDescriptor } from "@/lib/pkb/identity-labels";
import { isGenericAlt } from "@/lib/seo/readiness";
import {
  clampText,
  cleanTerms,
  containsWords,
  dedupeBy,
  keywordKey,
  normalizeKeyword,
  suggestSlug,
} from "./text";

/**
 * The rules generator: recommendations written from the product's own data
 * and the research that was actually collected, with no AI model and no
 * network call.
 *
 * It is deliberately conservative. It never states a fact the listing does
 * not already hold, never describes a photograph it cannot see, and only
 * proposes a misspelling that shoppers were recorded typing. Where it has
 * nothing real to go on it says so rather than filling the space.
 */

/** The site's name is appended by the layout: " · Manifest". */
const TITLE_SUFFIX_LENGTH = SITE_TITLE_SUFFIX.length;
const TITLE_BODY_MAX = 60 - TITLE_SUFFIX_LENGTH;

/** What the product is: the name up to its first comma, bracket or dash. */
export function coreName(title: string): string {
  const core = title.split(/\s[–—|:-]\s|,|\(|\[/)[0]?.trim() ?? "";
  return core.length >= 3 ? core : title.trim();
}

function withoutBrand(name: string, brand: string | null): string {
  if (!brand) return name;
  const lower = name.toLowerCase();
  const prefix = `${brand.toLowerCase()} `;
  return lower.startsWith(prefix) ? name.slice(prefix.length).trim() : name;
}

function firstWords(value: string, count: number): string {
  return value.split(/\s+/).slice(0, count).join(" ");
}

function titleCase(value: string): string {
  return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function shortValue(value: string | undefined | null, max = 24): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max || /[.;]/.test(trimmed)) return null;
  return trimmed;
}

function keyword(
  value: string,
  intent: KeywordRecommendation["intent"],
  relevance: KeywordRecommendation["relevance"],
  reason: string,
): KeywordRecommendation {
  return { keyword: normalizeKeyword(value).slice(0, 80), intent, relevance, reason };
}

/** Splits "AirPods" into "air pods" and "WH-1000XM5" into its spacing variants. */
function spacingVariants(word: string): string[] {
  const variants: string[] = [];
  const camel = word.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (camel !== word) variants.push(camel);
  if (/[-_]/.test(word)) {
    variants.push(word.replace(/[-_]/g, ""));
    variants.push(word.replace(/[-_]/g, " "));
  }
  const digitSplit = word.replace(/([a-zA-Z])(\d)/g, "$1 $2");
  if (digitSplit !== word && /\d/.test(word)) variants.push(digitSplit);
  return variants;
}

/**
 * The site's synonym rows that are about this product: a row counts when one
 * of its terms is made only of words from the product's name, brand or
 * product type. The rest of the table is about other products ("sunblock",
 * "frying pan") and is not search wording for this one.
 */
export function relevantSiteSynonyms(input: SeoPulseInput, research: SeoResearchData) {
  const brand = input.brand?.trim() || null;
  const productType = (input.categoryPath.at(-1) ?? "").toLowerCase();
  const vocabulary = new Set(keywordKey(`${input.title} ${brand ?? ""} ${productType}`).split(" "));
  return (research.siteSearch?.existingSynonyms ?? []).filter((entry) =>
    [entry.term, ...entry.synonyms].some((term) =>
      keywordKey(term).split(" ").every((word) => vocabulary.has(word)),
    ),
  );
}

export function generateByRules(
  input: SeoPulseInput,
  research: SeoResearchData,
): GeneratedRecommendations {
  const brand = input.brand?.trim() || null;
  const core = coreName(input.title);
  const model = withoutBrand(core, brand);
  const productType = (input.categoryPath.at(-1) ?? "").toLowerCase();
  const color = shortValue(input.details.color);
  const material = shortValue(input.details.material);
  const size = shortValue(input.details.size);
  const use = shortValue(input.details.intendedUse, 30);
  const compatibility = shortValue(input.details.compatibility, 30);
  const siteQueries = research.siteSearch?.matchingQueries ?? [];
  const metrics = research.keywordMetrics;

  // -------------------------------------------------------------- primary

  const nameKeyword = firstWords(
    brand && !containsWords(model, brand) ? `${brand} ${model}` : core,
    6,
  );

  let primary = keyword(
    nameKeyword,
    "transactional",
    "high",
    "Names the exact product. Someone typing it knows what they want and is ready to compare prices or buy.",
  );

  // Real demand beats a guess: the most-searched phrase that names this product.
  const withVolume = metrics
    .filter((metric) => metric.searchVolume !== null && containsWords(metric.keyword, model))
    .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))[0];
  const topSiteQuery = siteQueries
    .filter((query) => query.searches >= 3 && containsWords(query.query, firstWords(model, 2)))
    .sort((a, b) => b.searches - a.searches)[0];

  if (withVolume) {
    primary = keyword(
      withVolume.keyword,
      "transactional",
      "high",
      `Highest measured search volume among phrases naming this product: ${withVolume.searchVolume}/month (${withVolume.source}).`,
    );
  } else if (topSiteQuery) {
    primary = keyword(
      topSiteQuery.query,
      "transactional",
      "high",
      `Typed ${topSiteQuery.searches} times on this site's own search in the last ${research.siteSearch?.windowDays} days.`,
    );
  }

  // ------------------------------------------------------------ secondary

  const secondary: KeywordRecommendation[] = [];
  if (keywordKey(model) !== keywordKey(primary.keyword)) {
    secondary.push(
      keyword(model, "product", "high", "The product name without the brand, as many shoppers type it."),
    );
  }
  if (brand && productType) {
    secondary.push(
      keyword(`${brand} ${productType}`, "navigational", "medium", "Brand plus product type: shoppers who trust the brand and are browsing its range."),
    );
  }
  for (const attribute of [color, size, material].filter(Boolean) as string[]) {
    secondary.push(
      keyword(`${firstWords(model, 4)} ${attribute}`, "product", "medium", `Product plus a stated specification ("${attribute}").`),
    );
  }
  if (productType && !containsWords(model, productType)) {
    secondary.push(
      keyword(productType, "commercial", "medium", "The category term — broad, but it is how shoppers start comparing."),
    );
  }
  if (use && productType) {
    secondary.push(
      keyword(`${productType} for ${use}`, "use_case", "medium", `From the intended use recorded on the listing ("${use}").`),
    );
  }
  if (compatibility && productType) {
    secondary.push(
      keyword(`${productType} for ${compatibility}`, "product", "medium", `From the compatibility recorded on the listing ("${compatibility}").`),
    );
  }
  for (const metric of metrics) {
    if (metric.searchVolume && metric.searchVolume > 0 && keywordKey(metric.keyword) !== keywordKey(primary.keyword)) {
      secondary.push(
        keyword(metric.keyword, "product", "medium", `Measured at ${metric.searchVolume}/month (${metric.source}).`),
      );
    }
  }

  // ------------------------------------------------------------ long tail

  const longTail: KeywordRecommendation[] = [
    keyword(
      `${firstWords(nameKeyword, 5)} price in bangladesh`,
      "transactional",
      "high",
      "This shop sells in Bangladesh, where \"price in Bangladesh\" / \"price in BD\" is the common way to search before buying.",
    ),
  ];
  if (brand) {
    longTail.push(
      keyword(
        `original ${brand} ${productType || firstWords(model, 3)} in bangladesh`,
        "commercial",
        "medium",
        "The shop imports from the United States; shoppers wary of copies search for the original.",
      ),
    );
  }
  if (use && productType) {
    longTail.push(
      keyword(`best ${productType} for ${use}`, "commercial", "medium", "Comparison search built on the recorded intended use."),
    );
  }
  if (compatibility) {
    longTail.push(
      keyword(`is ${firstWords(model, 4)} compatible with ${compatibility}`, "informational", "low", "A question the recorded compatibility answers."),
    );
  }
  longTail.push(
    keyword(`buy ${firstWords(nameKeyword, 5)} online`, "transactional", "medium", "Purchase intent without a location."),
  );
  for (const query of siteQueries) {
    if (query.query.split(" ").length >= 3) {
      longTail.push(
        keyword(query.query, "product", "medium", `Typed ${query.searches} times on this site's own search.`),
      );
    }
  }

  const primaryKey = keywordKey(primary.keyword);
  const secondaryKeywords = dedupeBy(secondary, (item) => keywordKey(item.keyword))
    .filter((item) => keywordKey(item.keyword) !== primaryKey)
    .slice(0, 8);
  const taken = new Set([primaryKey, ...secondaryKeywords.map((item) => keywordKey(item.keyword))]);
  const longTailKeywords = dedupeBy(longTail, (item) => keywordKey(item.keyword))
    .filter((item) => !taken.has(keywordKey(item.keyword)))
    .slice(0, 8);

  // ------------------------------------------------------- internal search

  const siteSynonyms = relevantSiteSynonyms(input, research);
  const synonyms = cleanTerms(
    [
      ...siteSynonyms.flatMap((entry) => [entry.term, ...entry.synonyms]),
      ...(productType
        ? [productType.endsWith("s") ? productType.slice(0, -1) : `${productType}s`]
        : []),
    ].filter((term) => keywordKey(term) !== keywordKey(productType)),
    10,
  );

  const relatedTerms = cleanTerms(
    [
      ...input.categoryPath,
      ...(input.details.specialFeatures ?? "").split(/[,;]/).filter((part) => part.trim().length <= 40),
      ...(material ? [material] : []),
      ...(research.serp.flatMap((snapshot) => snapshot.relatedSearches)),
    ],
    12,
  );

  /*
   * How people actually shorten a product name: "3rd Generation" becomes "3",
   * the model family is searched on its own ("AirPods Pro"), and so is brand
   * plus family ("Apple AirPods") and brand plus type ("Apple earbuds", when
   * the category says earbuds). All derived from the name and category —
   * nothing added that the listing does not already say.
   */
  const generationless = model
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+gen(?:eration)?\b/gi, "$1")
    .replace(/\bgen(?:eration)?\s+(\d+)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const familyWords = model.split(/\s+/).filter((word) => word && !/\d/.test(word) && !/^(gen|generation|\d+(st|nd|rd|th))$/i.test(word));
  const family = familyWords.slice(0, 2).join(" ");
  const titleWords = input.title.split(/\s+/);
  const searchAliases = cleanTerms(
    [
      ...(generationless !== model ? [generationless] : []),
      ...(family && family.toLowerCase() !== model.toLowerCase() ? [family] : []),
      ...(brand && familyWords[0] ? [`${brand} ${familyWords[0]}`] : []),
      ...(brand && productType ? [`${brand} ${productType}`] : []),
      ...titleWords.flatMap(spacingVariants),
      ...(brand ? spacingVariants(brand) : []),
      model,
      // Only a code that identifies the product is a search term (D-123):
      // "10" or "Shade 10" would match every product carrying a ten.
      ...(input.details.modelNumber && isStrongModelKey(input.details.modelNumber)
        ? [input.details.modelNumber, ...spacingVariants(input.details.modelNumber)]
        : []),
      ...(input.details.modelName && !variantDescriptor(input.details.modelName) ? [input.details.modelName] : []),
      ...(input.details.manufacturerPartNumber && isStrongModelKey(input.details.manufacturerPartNumber)
        ? [input.details.manufacturerPartNumber]
        : []),
    ].filter((term) => keywordKey(term) !== keywordKey(input.title)),
    12,
  );

  const misspellings = dedupeBy(
    (research.siteSearch?.correctedTypos ?? []).map((typo) => ({
      term: normalizeKeyword(typo.typed).slice(0, 60),
      basis: `Typed ${typo.searches} time${typo.searches === 1 ? "" : "s"} on this site's search and corrected to "${typo.corrected}".`,
    })),
    (item) => keywordKey(item.term),
  ).slice(0, 8);

  const searchPhrases = cleanTerms(
    [
      ...(brand && productType ? [`${productType} ${brand}`] : []),
      ...(use ? [`${firstWords(model, 3)} for ${use}`] : []),
      ...siteQueries.map((query) => query.query),
    ],
    8,
  );

  const brandVariations = brand
    ? cleanTerms(
        [
          brand,
          brand.replace(/\s+/g, ""),
          brand.replace(/&/g, "and"),
          brand.replace(/\band\b/gi, "&"),
          ...spacingVariants(brand),
        ],
        6,
      )
    : [];

  // --------------------------------------------------------------- titles

  const displayName = brand && !containsWords(model, brand) ? `${brand} ${model}` : core;
  // Least useful words out first, never a cut word or phrase (D-129).
  const fitted = fitSeoTitle(displayName, titleIdentity(input), { target: TITLE_BODY_MAX });

  // ---------------------------------------------------------- description

  // SEO Pulse's own earlier features are not the staff's (D-120): building on
  // them would only print the last version's wording again.
  const ownFeatures = input.pulseWritten?.bulletFeatures ? [] : input.bulletFeatures;

  const specs = specificationRows(input);
  const measures = measurementRows(input);

  /*
   * Key features, when staff have written none, out of what is already
   * established about the product (D-115).
   *
   * This is still the conservative rule: nothing is invented and nothing is
   * reworded into a claim. A line is one recorded fact, printed as it was
   * recorded — "Charging time: approx. 3.5 hours". What changed is that a
   * researched product now *has* such facts, where before this generator only
   * ever saw a title, a category and a delivery term, and so had nothing to
   * say about the product and said the shop's part instead.
   *
   * Rows that only name the product are left out: a shopper reading "Brand:
   * Sony" or "Part number: GO-WHITE" under Key features has learnt nothing
   * the title did not tell them. Which labels name a product is decided in
   * one place, `lib/pkb/identity-labels.ts` (D-119).
   */
  // What the product does before what it measures (D-120): the first line is
  // also the description's opening, and "Size: Standard" says less about a
  // mouse than its sensor or its connection does.
  // The warranty is an assurance term with its own section on the product
  // page, not something the product does; it is not a feature to open on.
  /*
   * How to use it and what to be careful of are established facts too, but
   * they are instructions, not features (D-123): they stay in the
   * specifications. A value that is a list of the manufacturer's own
   * statements — "New + improved with…; Less hair lost from breakage…" — is
   * printed as those statements, one per line, exactly as recorded, rather
   * than as one run-on line under its label.
   */
  const NOT_A_FEATURE = /\b(warranty|how to|directions?|instructions?|usage|steps?|warnings?|cautions?|precautions?)\b/i;
  const statements = (value: string) => {
    const parts = value.split(/;\s+/).map((part) => part.trim()).filter(Boolean);
    return parts.length >= 2 && parts.every((part) => part.length >= 25 && /\s/.test(part)) ? parts : null;
  };
  const featureRows = [...specs, ...measures].filter((row) => !isIdentityLabel(row.label) && !NOT_A_FEATURE.test(row.label));
  /*
   * A key point is a line a shopper reads — "12GB GDDR7 memory" — not the
   * "Memory: 12GB GDDR7" line At a Glance and the specification table already
   * show (D-128). Still one recorded fact each, reworded by a fixed rule and
   * never extended.
   */
  const groundedFeatures = featureRows
    .flatMap((row) => statements(row.value)?.slice(0, 4) ?? [keyPointFromFact(row.label, row.value) ?? ""])
    .filter(Boolean)
    .map((line) => clampText(line, 180))
    .slice(0, 6);
  // Staff-written features are the source when there are any; a line among
  // them that only restates an identifier is not repeated as a feature.
  const staffFeatures = ownFeatures.filter((feature) => !isIdentityLine(feature));
  const features = staffFeatures.length > 0 ? staffFeatures : groundedFeatures;
  const sufficient = knowledgeSufficiency(input).sufficient;

  // --------------------------------------------------------------- titles

  /*
   * The title and the snippet say what the product is (D-123). They used to
   * be "<name> – Price in Bangladesh" and "<name>. Order now, sourced from the
   * US and delivered across Bangladesh at a fixed landed price." for every
   * product alike: commerce copy about the shop, identical on every page. The
   * name is the title; a established fact about the product, when it fits,
   * tells a searcher which one this is. "price in bangladesh" stays a search
   * phrase (below), which is what people type — not what a title must say.
   */
  // A short labelled fact the name does not already say ("Black (010)" adds
  // nothing to "… - Black" but its code). The value stands without its label
  // here, so one that says nothing alone — "7" (buttons), "Yes" — is not used:
  // it made the title "<name> – 7".
  const firstFact = featureRows
    .filter((row) => !statements(row.value))
    .map((row) => row.value.trim())
    .filter((value) => /\p{L}{2,}/u.test(value) && !/^(yes|no|true|false)$/i.test(value))
    .find((value) => value.length <= 28 && !keywordKey(value).split(" ").some((word) => word && containsWords(displayName, word)));
  const candidates = [
    firstFact && sufficient ? `${fitted} – ${firstFact}` : "",
    productType ? `${fitted} | ${titleCase(productType)}` : "",
    `${fitted}${color ? ` – ${titleCase(color)}` : ""}`,
    fitted,
  ].filter((candidate, index, all) => candidate && candidate.length <= TITLE_BODY_MAX + 4 && all.indexOf(candidate) === index);
  const recommendedTitle = candidates[0] ?? fitted;

  /*
   * The meta description, from established facts only, and none without them
   * (D-123): a snippet made of the shop's delivery terms describes the shop.
   */
  /*
   * One sentence, not a list (D-129): "<name> features 12GB GDDR7 memory,
   * 2685 MHz boost clock and PCIe 5.0 interface." — the content plan's
   * highest-ranked facts that read well inside a sentence, at most three, and
   * "for <use>" only when the listing states one. Staff's own short feature
   * lines stand in when no fact does. Nothing that reads well → no snippet.
   */
  const staffLines = staffFeatures
    .map((line) => line.trim().replace(/[.\s]+$/, ""))
    .filter((line) => line.length <= 40 && !/[,;:]/.test(line) && line.split(/\s+/).length <= 6 && !mentionsWarranty(line) && textLanguage(line, [input.title]).nonLatin <= 0.3)
    .map((line) => (/^\p{Lu}\p{Ll}+\b/u.test(line) ? line.charAt(0).toLowerCase() + line.slice(1) : line));
  const meta = sufficient
    ? factMetaSentence(
        { facts: prioritizedFacts(input), exactName: displayName },
        { use: use && !mentionsWarranty(use) && !use.match(EVALUATIVE_PATTERN) ? use.toLowerCase() : null, extra: staffLines, max: 155 },
      )
    : "";

  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sentence = (value: string) =>
    /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;

  /*
   * The description, written from the listing's own facts and nothing else
   * (D-043).
   *
   * It grows with the product rather than to a word count: a listing with
   * three features, a specification table and measurements gets an opening,
   * a feature list, both tables and a delivery note; a listing with only a
   * name and a category gets two honest sentences. Every section appears at
   * most once, and no sentence is repeated in another form — the padding that
   * makes generated copy obvious is exactly what a shopper skips.
   */
  const opening: string[] = [];

  /*
   * The first sentence is about the product (D-119). It used to be
   * "<product> is part of our Electronics range." — true of every product in
   * the category, so it told a shopper nothing, and on a product nobody had
   * researched it was the whole description. The opening now leads with the
   * first thing actually established about the product; with nothing
   * established there is no description at all (see `sufficient` below),
   * rather than one made of the category's name.
   */
  /*
   * With features staff wrote, the opening is the name and the first of
   * them, in their words. With none, it used to be the name and one recorded
   * fact — a one-line description. It is now a short paragraph of the
   * established facts, grouped as a person would read them out
   * (`factParagraph`): still nothing but the facts, and no longer than there
   * are facts to say.
   */
  const factOpening = staffFeatures.length === 0 ? factParagraph({ facts: prioritizedFacts(input), exactName: displayName }) : [];
  if (factOpening.length > 0) opening.push(...factOpening);
  else opening.push(features[0] ? `${displayName} — ${features[0].replace(/[.\s]+$/, "")}.` : `${displayName}.`);
  const said = labelKey(factOpening.join(" "));
  const alreadySaid = (value: string | null) => Boolean(value && said.includes(labelKey(value)));

  // Only descriptors the listing actually records, and only once each: they
  // are the words a shopper scans for, and the words a search engine matches.
  // "It comes with in Standard." was what a size on its own produced, and
  // "It comes in Standard." what came after it (D-120): a named size is not a
  // phrase that fits "comes in". Only a measured size ("42 mm") is said here;
  // a named one stays in the specifications, where it reads as "Size: Standard".
  const sayableSize = size && /\d/.test(size) ? size : null;
  // "It comes with finished in Black (010)." was what a colour on its own
  // produced (D-123): each descriptor now has a verb that fits it.
  // Nothing is said twice: a colour or material the paragraph above already
  // gave as a fact is not repeated as a descriptor.
  const comesIn = [color, sayableSize].filter((value) => value && !alreadySaid(value)).join(", ");
  if (material && !alreadySaid(material)) {
    opening.push(`It has ${material} construction${comesIn ? ` and comes in ${comesIn}` : ""}.`);
  } else if (comesIn) {
    opening.push(`It comes in ${comesIn}.`);
  }

  if (use) opening.push(sentence(`It is intended for ${use}`));
  if (compatibility) opening.push(sentence(`It works with ${compatibility}`));

  /*
   * No "Buying it here" section (D-119). Preorder status, the arrival
   * window, the landed price and delivery are the shop's live terms, not facts
   * about the product: written into the description they were frozen at the
   * moment of generation and went stale the day the batch or the price
   * changed. The product page shows them from the current offer, beside the
   * price, where they stay true.
   *
   * And no description at all without enough established about the product
   * (D-115): what would remain is a name and a sentence of filler, and the
   * description is left for a person or a later, researched run to write.
   */
  const suggestedHtml = !sufficient
    ? null
    : [
      `<p>${escape(opening.join(" "))}</p>`,
      features.length > 0
        ? `<h2>Key features</h2><ul>${features
            .map((item) => `<li>${escape(item)}</li>`)
            .join("")}</ul>`
        : "",
      /*
       * No specification or measurement list here. The product page shows
       * both as their own tabs, built from the same recorded facts, and
       * repeating them inside the description is exactly the duplication a
       * shopper reads as padding (D-043).
       */
      input.boxContents.length > 0
        ? `<h2>In the box</h2><ul>${input.boxContents
            .map((item) => `<li>${escape(item)}</li>`)
            .join("")}</ul>`
        : "",
    ].join("") || null;

  const facts = [
    ...specs.map((entry) => `${entry.label}: ${entry.value}`),
    ...measures.map((entry) => `${entry.label}: ${entry.value}`),
  ];

  const improvements: string[] = [];
  if (input.descriptionText.length < 300) {
    improvements.push("Open with one or two sentences saying what the product is and who it is for.");
  }
  if (!containsWords(input.descriptionText, firstWords(primary.keyword, 3))) {
    improvements.push(`Use the phrase "${primary.keyword}" once, naturally, near the start.`);
  }
  if (input.bulletFeatures.length < 3) {
    improvements.push("List at least three key features as short lines.");
  }
  if (facts.length < 3) {
    improvements.push("Add specifications — dimensions, weight, material — the details comparison searches match.");
  }
  if (!input.details.compatibility) {
    improvements.push("State compatibility, if the product works with other devices or parts.");
  }
  improvements.push("Say what arrives in the box and whether there is a warranty — both are common questions.");

  // --------------------------------------------------------------- images

  const imageAlts = input.images.map((image, index) => {
    if (!isGenericAlt(image.altText, input.title)) {
      return {
        imageId: image.id,
        altText: clampText(image.altText, 125),
        title: null,
        needsReview: false,
        reason: "The current text is already specific. Kept.",
      };
    }
    const label = image.kind === "lifestyle" ? "in use" : `photograph ${index + 1}`;
    return {
      imageId: image.id,
      altText: clampText(`${displayName}${color ? `, ${color}` : ""} — ${label}`, 125),
      title: null,
      needsReview: true,
      reason: "SEO Pulse cannot see the photograph. Describe what it actually shows (angle, colour, what is in frame) before applying.",
    };
  });

  // ----------------------------------------------------------------- FAQs

  const arrival = input.variants.find((variant) => variant.arrivesFrom);
  const faqs: GeneratedRecommendations["faqs"] = [
    {
      question: `When will ${firstWords(displayName, 6)} arrive in Bangladesh?`,
      answer: arrival
        ? `Estimated arrival ${arrival.arrivesFrom}${arrival.arrivesTo ? ` to ${arrival.arrivesTo}` : ""}.`
        : null,
      needsManualAnswer: !arrival,
      basis: arrival ? "The variant's recorded arrival window." : "No arrival window is recorded.",
    },
    {
      question: `Is this the original ${brand ?? "product"}?`,
      answer: null,
      needsManualAnswer: true,
      basis: "An authenticity claim has to come from staff, not from generated text.",
    },
    {
      question: "Does it come with a warranty?",
      answer: input.warranty
        ? input.warranty.hasWarranty
          ? `Yes${input.warranty.durationMonths ? `, ${input.warranty.durationMonths} months` : ""}.`
          : "No warranty is included."
        : null,
      needsManualAnswer: !input.warranty,
      basis: input.warranty ? "The recorded warranty." : "No warranty information is recorded.",
    },
    {
      question: "What is in the box?",
      answer: input.boxContents.length > 0 ? clampText(input.boxContents.join(", "), 600) : null,
      needsManualAnswer: input.boxContents.length === 0,
      basis: input.boxContents.length > 0 ? "The recorded box contents." : "Box contents are not recorded.",
    },
  ];
  if (input.details.compatibility) {
    faqs.push({
      question: "What is it compatible with?",
      answer: clampText(input.details.compatibility, 600),
      needsManualAnswer: false,
      basis: "The recorded compatibility.",
    });
  }
  for (const question of research.serp.flatMap((snapshot) => snapshot.peopleAlsoAsk).slice(0, 3)) {
    faqs.push({
      question: clampText(question, 200),
      answer: null,
      needsManualAnswer: true,
      basis: "Asked in search results (\"People also ask\").",
    });
  }

  // ----------------------------------------------------------------- tags

  const tags = cleanTerms(
    [productType, brand ?? "", ...input.categoryPath.slice(0, -1), color ?? "", material ?? "", use ?? ""],
    8,
    40,
  );

  const categoryNotes: string[] = [];
  if (productType && !containsWords(`${input.title} ${input.searchKeywords.join(" ")}`, productType)) {
    categoryNotes.push(
      `The category word "${productType}" is not in the name or the search keywords; adding it helps shoppers who search by type.`,
    );
  }
  if (input.categoryPath.length === 1) {
    categoryNotes.push("Filed in a top-level category. A more specific sub-category, if one fits, narrows the audience. Nothing is moved automatically.");
  }

  return {
    primaryKeyword: primary,
    secondaryKeywords,
    longTailKeywords,
    synonyms,
    relatedTerms,
    searchAliases,
    misspellings,
    searchPhrases,
    brandVariations,
    seoTitle: {
      recommended: recommendedTitle,
      alternatives: candidates.slice(1, 4),
      reason: `Leads with the product name so the page is recognisable, and fits within 60 characters once the site name is added.`,
    },
    metaDescription: {
      // Under 50 characters is too short to be a snippet; empty is honest.
      recommended: meta.length >= 50 ? meta : "",
      reason: meta.length >= 50
        ? "Names the product and the established facts a searcher compares, under 160 characters so it shows in full."
        : "Left empty: too little is established about the product to say anything true in a search snippet. It is prepared once product information is verified.",
    },
    h1: {
      recommended:
        input.title.length >= 10 && input.title.length <= 120 && input.title !== input.title.toUpperCase()
          ? input.title
          : clampText(titleCase(core.toLowerCase()), 120),
      reason: "The heading should say plainly what the product is. The current name already does this unless noted otherwise; a separate keyword-stuffed heading would read worse.",
    },
    slug: {
      recommended: suggestSlug(displayName),
      reason: "Brand and product name, lowercase and hyphenated, without filler words.",
    },
    description: { improvements: improvements.slice(0, 8), suggestedHtml },
    tags,
    // The rules never invent a feature: they have none to add beyond what the
    // listing already lists. Claude, when connected, drafts them.
    keyFeatures: ownFeatures.length > 0 ? [] : groundedFeatures,
    imageAlts,
    faqs: faqs.slice(0, 8),
    categoryNotes,
  };
}
