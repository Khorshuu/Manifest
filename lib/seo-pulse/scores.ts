import type { ScoreCheck, ScoreResult, SeoPulseInput } from "./types";
import { containsWords } from "./text";

/**
 * The two SEO Pulse scores. Both describe how complete this shop's own
 * listing is — they are not a Google ranking and never claim to be. Each is a
 * list of weighted checks over fields that actually exist, so the number can
 * always be explained by the list beside it.
 */

const GENERIC_ALT = /^(image|photo|picture|img|product|untitled)\b|\.(jpe?g|png|webp|gif|avif)$/i;

/** An alt text too thin to describe anything: empty, a filename, "image". */
export function isGenericAlt(alt: string, title: string): boolean {
  const value = alt.trim();
  if (value.length < 8) return true;
  if (GENERIC_ALT.test(value)) return true;
  return value.toLowerCase() === title.trim().toLowerCase();
}

function specificationCount(input: SeoPulseInput): number {
  return input.specifications.length + Object.keys(input.details).length;
}

function tally(checks: ScoreCheck[]): ScoreResult {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks
    .filter((check) => check.passed)
    .reduce((sum, check) => sum + check.weight, 0);
  return { score: total === 0 ? 0 : Math.round((earned / total) * 100), checks };
}

/** SEO Pulse Optimization Score — how ready the listing is for search engines. */
export function seoScore(input: SeoPulseInput): ScoreResult {
  const keyword = input.seoFocusKeyword?.trim() ?? "";
  const shownTitle = input.seoMetaTitle?.trim() || input.title;
  const meta = input.seoMetaDescription?.trim() ?? "";
  const hasPrice = input.variants.length > 0;
  const gallery = input.images.filter((image) => image.kind === "gallery");

  const checks: ScoreCheck[] = [
    {
      id: "focus_keyword",
      label: "Focus keyword chosen",
      passed: keyword.length > 0,
      weight: 10,
      hint: "Pick the one phrase this listing should rank for.",
    },
    {
      id: "keyword_in_title",
      label: "Focus keyword in the SEO title",
      passed: keyword.length > 0 && containsWords(shownTitle, keyword),
      weight: 10,
      hint: "Search engines weigh the title heavily; the phrase belongs there.",
    },
    {
      id: "seo_title_length",
      label: "SEO title written, 30–60 characters",
      passed:
        (input.seoMetaTitle?.trim().length ?? 0) >= 30 &&
        (input.seoMetaTitle?.trim().length ?? 0) <= 60,
      weight: 10,
      hint: "Longer titles are cut short in results; shorter ones waste the space.",
    },
    {
      id: "meta_description",
      label: "Meta description written, 70–160 characters",
      passed: meta.length >= 70 && meta.length <= 160,
      weight: 10,
      hint: "Without one, search engines invent a snippet from the page.",
    },
    {
      id: "keyword_in_meta",
      label: "Focus keyword in the meta description",
      passed: keyword.length > 0 && containsWords(meta, keyword),
      weight: 5,
      hint: "Matching words are shown in bold in the result.",
    },
    {
      id: "slug",
      label: "Short, readable address",
      passed: input.slug.length <= 60 && !/-\d+$/.test(input.slug),
      weight: 5,
      hint: "Under 60 characters, without a numeric suffix.",
    },
    {
      id: "h1",
      label: "Clear product name (the page heading)",
      passed:
        input.title.length >= 10 &&
        input.title.length <= 120 &&
        input.title !== input.title.toUpperCase(),
      weight: 5,
      hint: "10–120 characters, not in capitals.",
    },
    {
      id: "description",
      label: "Description of at least 300 characters",
      passed: input.descriptionText.length >= 300,
      weight: 10,
      hint: "Thin pages rank poorly and answer fewer questions.",
    },
    {
      id: "bullets",
      label: "At least three key features",
      passed: input.bulletFeatures.length >= 3,
      weight: 5,
      hint: "Scannable features serve shoppers and search engines alike.",
    },
    {
      id: "specifications",
      label: "At least three specifications",
      passed: specificationCount(input) >= 3,
      weight: 5,
      hint: "Specifications are what comparison searches match on.",
    },
    {
      id: "image_alt",
      label: "Every photograph has descriptive alt text",
      passed:
        gallery.length > 0 &&
        input.images.every((image) => !isGenericAlt(image.altText, input.title)),
      weight: 10,
      hint: "Alt text is how image search and screen readers know what is shown.",
    },
    {
      id: "identifier",
      label: "A trade identifier (GTIN, UPC, EAN, ISBN or MPN)",
      passed:
        (input.identifierValue !== null &&
          input.identifierType !== null &&
          input.identifierType !== "other") ||
        Boolean(input.details.manufacturerPartNumber),
      weight: 5,
      hint: "Only a real one — never invent an identifier.",
    },
    {
      id: "structured_data",
      label: "Structured data complete (name, brand, image, price, description)",
      passed:
        Boolean(input.brand) &&
        gallery.length > 0 &&
        hasPrice &&
        input.descriptionText.length > 0,
      weight: 10,
      hint: "Product rich results need all five.",
    },
  ];

  return tally(checks);
}

/** Internal Search Score — how findable the listing is on this site's own search. */
export function searchScore(input: SeoPulseInput): ScoreResult {
  const checks: ScoreCheck[] = [
    {
      id: "searchable",
      label: "Shown in site search",
      passed: input.searchable,
      weight: 15,
      hint: "Switched off, the search box never finds it.",
    },
    {
      id: "name",
      label: "Product name of two or more words",
      passed: input.title.trim().split(/\s+/).length >= 2,
      weight: 10,
      hint: "A one-word name matches too little.",
    },
    {
      id: "brand",
      label: "Brand recorded",
      passed: Boolean(input.brand),
      weight: 15,
      hint: "Many shoppers search by brand first.",
    },
    {
      id: "category",
      label: "Filed in a category",
      passed: input.categoryPath.length > 0,
      weight: 10,
      hint: "The category name is part of the search index.",
    },
    {
      id: "aliases",
      label: "At least three search keywords",
      passed: input.searchKeywords.length >= 3,
      weight: 20,
      hint: "Other names, spacing variants and real typos shoppers use.",
    },
    {
      id: "tags",
      label: "At least three tags",
      passed: input.tags.length >= 3,
      weight: 15,
      hint: "Tags feed search and related products.",
    },
    {
      id: "attributes",
      label: "At least two searchable specifications",
      passed: specificationCount(input) >= 2,
      weight: 15,
      hint: "Colour, size and material are words shoppers type.",
    },
  ];

  return tally(checks);
}
