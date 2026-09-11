import type {
  GeneratedRecommendations,
  KeywordRecommendation,
  SeoPulseInput,
  SeoResearchData,
} from "./types";
import { isGenericAlt } from "./scores";
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
const TITLE_SUFFIX_LENGTH = " · Manifest".length;
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

  const vocabulary = new Set(keywordKey(`${input.title} ${brand ?? ""} ${productType}`).split(" "));
  const siteSynonyms = (research.siteSearch?.existingSynonyms ?? []).filter((entry) =>
    [entry.term, ...entry.synonyms].some((term) =>
      keywordKey(term).split(" ").every((word) => vocabulary.has(word)),
    ),
  );
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
      ...(input.details.modelNumber ? [input.details.modelNumber, ...spacingVariants(input.details.modelNumber)] : []),
      ...(input.details.modelName ? [input.details.modelName] : []),
      ...(input.details.manufacturerPartNumber ? [input.details.manufacturerPartNumber] : []),
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
  const fitted = clampText(displayName, TITLE_BODY_MAX);
  const candidates = [
    `${fitted} – Price in Bangladesh`,
    `Buy ${fitted} in Bangladesh`,
    productType ? `${fitted} | ${titleCase(productType)}` : "",
    `${fitted}${color ? ` – ${titleCase(color)}` : ""}`,
    fitted,
  ].filter((candidate) => candidate && candidate.length <= TITLE_BODY_MAX + 4);
  const recommendedTitle = candidates[0] ?? fitted;

  // ---------------------------------------------------------- description

  const preorder = input.variants.some((variant) => variant.fulfillmentMode === "preorder");
  const lead = input.bulletFeatures[0]
    ? `${displayName} — ${input.bulletFeatures[0].replace(/\.$/, "")}.`
    : `${displayName}.`;
  const meta = clampText(
    `${lead} ${preorder ? "Preorder now" : "Order now"}, sourced from the US and delivered across Bangladesh at a fixed landed price.`,
    158,
  );

  const facts = [
    ...input.specifications.map((row) => `${row.label}: ${row.value}`),
    ...Object.entries(input.details).map(
      ([label, value]) => `${label.replace(/([A-Z])/g, " $1").toLowerCase()}: ${value}`,
    ),
  ];
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  /*
   * With nothing else on the listing, the introduction says only what is true
   * of every product this shop sells: what it is, where it is filed, and how
   * it reaches Bangladesh. Staff add the rest; nothing about the product
   * itself is invented.
   */
  const intro = `${displayName}${
    input.categoryPath.length > 0 ? ` — from our ${input.categoryPath.join(" › ")} range` : ""
  }. Sourced from the United States and delivered across Bangladesh at a fixed landed price${
    preorder ? "; order now to reserve one from the next batch" : ""
  }.`;
  const suggestedHtml =
    input.descriptionText.length < 300
      ? [
          `<p>${escape(input.bulletFeatures[0] ? lead : intro)}</p>`,
          input.bulletFeatures.length > 0
            ? `<h2>Key features</h2><ul>${input.bulletFeatures.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`
            : "",
          facts.length > 0
            ? `<h2>Specifications</h2><ul>${facts.slice(0, 15).map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`
            : "",
          input.boxContents.length > 0
            ? `<h2>In the box</h2><ul>${input.boxContents.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`
            : "",
        ].join("")
      : null;

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
      recommended: meta.length >= 50 ? meta : clampText(`${meta} Sourced from the US for shoppers in Bangladesh.`, 158),
      reason: "Names the product, gives one real feature, and says how it reaches Bangladesh — under 160 characters so it shows in full.",
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
    keyFeatures: [],
    imageAlts,
    faqs: faqs.slice(0, 8),
    categoryNotes,
  };
}
