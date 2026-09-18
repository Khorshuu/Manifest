import type { SeoPulseInput } from "@/lib/seo-pulse/types";
import { containsWords } from "@/lib/seo-pulse/text";

/**
 * Search readiness as measurable checks (D-081, finding F13).
 *
 * What replaced the two 0–100 "scores": every check states a fact about the
 * listing that can be verified by looking at it, and says what to do when it
 * fails. There is no weighting and no total, because a weighted total reads
 * like a ranking prediction — and this shop has no way to predict a ranking.
 *
 * A check is one of three things:
 *  - **pass** — the condition holds.
 *  - **fail** — it does not, and the fix is a field on this listing.
 *  - **unknown** — it cannot be decided from Manifest's own data (nothing here
 *    returns `unknown` yet; Stage 6 adds checks that depend on Search Console).
 *
 * Severity says how much it matters, in words: `required` for the things a
 * product page cannot do without, `recommended`, `optional`.
 */

export type CheckState = "pass" | "fail" | "unknown";
export type CheckSeverity = "required" | "recommended" | "optional";

export type ReadinessCheck = {
  id: string;
  label: string;
  state: CheckState;
  severity: CheckSeverity;
  /** What is actually there, in plain words: "38 characters", "no alt text on 2 of 5". */
  detail: string;
  /** What to do about a failure. Omitted on a pass. */
  fix?: string;
};

export type ReadinessReport = {
  checks: ReadinessCheck[];
  passed: number;
  failed: number;
  unknown: number;
  /** Failures that are `required` — the ones that stop a page working. */
  blocking: number;
};

export function summarise(checks: ReadinessCheck[]): ReadinessReport {
  return {
    checks,
    passed: checks.filter((check) => check.state === "pass").length,
    failed: checks.filter((check) => check.state === "fail").length,
    unknown: checks.filter((check) => check.state === "unknown").length,
    blocking: checks.filter((check) => check.state === "fail" && check.severity === "required").length,
  };
}

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

function check(
  id: string,
  label: string,
  severity: CheckSeverity,
  passed: boolean,
  detail: string,
  fix: string,
): ReadinessCheck {
  return passed ? { id, label, state: "pass", severity, detail } : { id, label, state: "fail", severity, detail, fix };
}

/**
 * How ready one listing is to be found on a search engine. Every check reads
 * the listing's own fields; none of them guesses at Google's opinion.
 */
export function seoReadiness(input: SeoPulseInput): ReadinessReport {
  const keyword = input.seoFocusKeyword?.trim() ?? "";
  const metaTitle = input.seoMetaTitle?.trim() ?? "";
  const shownTitle = metaTitle || input.title;
  const meta = input.seoMetaDescription?.trim() ?? "";
  const gallery = input.images.filter((image) => image.kind === "gallery");
  const thinAlt = input.images.filter((image) => isGenericAlt(image.altText, input.title));
  const identifier =
    (input.identifierValue !== null && input.identifierType !== null && input.identifierType !== "other") ||
    Boolean(input.details.manufacturerPartNumber);

  const checks: ReadinessCheck[] = [
    check(
      "title",
      "A clear product name",
      "required",
      input.title.length >= 10 && input.title.length <= 120 && input.title !== input.title.toUpperCase(),
      `${input.title.length} characters`,
      "Between 10 and 120 characters, not in capitals.",
    ),
    check(
      "seo_title",
      "SEO title written, 30–60 characters",
      "recommended",
      metaTitle.length >= 30 && metaTitle.length <= 60,
      metaTitle ? `${metaTitle.length} characters` : "not written",
      "Longer titles are cut short in results; shorter ones waste the space.",
    ),
    check(
      "meta_description",
      "Meta description written, 70–160 characters",
      "recommended",
      meta.length >= 70 && meta.length <= 160,
      meta ? `${meta.length} characters` : "not written",
      "Without one, search engines write their own snippet from the page.",
    ),
    check(
      "focus_keyword",
      "Focus keyword chosen",
      "optional",
      keyword.length > 0,
      keyword || "not chosen",
      "Pick the one phrase this listing should be found by.",
    ),
    check(
      "keyword_in_title",
      "Focus keyword appears in the title shown",
      "optional",
      keyword.length > 0 && containsWords(shownTitle, keyword),
      keyword.length === 0 ? "no focus keyword" : containsWords(shownTitle, keyword) ? "present" : "missing",
      "Put the phrase in the SEO title, or choose a phrase the title uses.",
    ),
    check(
      "description",
      "Description of at least 300 characters",
      "required",
      input.descriptionText.length >= 300,
      `${input.descriptionText.length} characters`,
      "A page with little to read answers fewer questions and ranks worse.",
    ),
    check(
      "bullets",
      "At least three key features",
      "recommended",
      input.bulletFeatures.length >= 3,
      `${input.bulletFeatures.length} written`,
      "Scannable features serve shoppers and search engines alike.",
    ),
    check(
      "specifications",
      "At least three specifications recorded",
      "recommended",
      specificationCount(input) >= 3,
      `${specificationCount(input)} recorded`,
      "Specifications are what comparison searches match on.",
    ),
    check(
      "gallery",
      "At least one product photograph",
      "required",
      gallery.length > 0,
      `${gallery.length} photograph(s)`,
      "A product result without an image is rarely shown.",
    ),
    check(
      "image_alt",
      "Every photograph described",
      "recommended",
      input.images.length > 0 && thinAlt.length === 0,
      input.images.length === 0 ? "no photographs" : `${thinAlt.length} of ${input.images.length} need a description`,
      "Alt text is how image search and screen readers know what is shown.",
    ),
    check(
      "slug",
      "Short, readable address",
      "optional",
      input.slug.length <= 60 && !/-\d+$/.test(input.slug),
      `${input.slug.length} characters`,
      "Under 60 characters, without a numeric suffix.",
    ),
    check(
      "identifier",
      "A real trade identifier (GTIN, UPC, EAN, ISBN or MPN)",
      "recommended",
      identifier,
      identifier ? "recorded" : "none recorded",
      "Record the one printed on the product. Never invent one.",
    ),
    check(
      "offer",
      "At least one variant a shopper can buy",
      "required",
      input.variants.length > 0,
      `${input.variants.length} offer(s)`,
      "Structured data cannot state a price without an offer.",
    ),
    check(
      "brand",
      "Brand recorded",
      "recommended",
      Boolean(input.brand),
      input.brand ?? "not recorded",
      "Brand is part of both the rich result and how shoppers search.",
    ),
  ];

  return summarise(checks);
}

/**
 * How findable one listing is in this shop's own search. Same rules: a list of
 * facts, no score. SearchPulse (Stage 5) extends this with its own measures.
 */
export function searchReadiness(input: SeoPulseInput): ReadinessReport {
  const checks: ReadinessCheck[] = [
    check(
      "searchable",
      "Shown in site search",
      "required",
      input.searchable,
      input.searchable ? "on" : "off",
      "Switched off, the search box never finds it.",
    ),
    check(
      "name_words",
      "Product name of two or more words",
      "required",
      input.title.trim().split(/\s+/).length >= 2,
      `${input.title.trim().split(/\s+/).length} word(s)`,
      "A one-word name matches too little to be found reliably.",
    ),
    check(
      "brand",
      "Brand recorded",
      "recommended",
      Boolean(input.brand),
      input.brand ?? "not recorded",
      "Many shoppers search by brand first.",
    ),
    check(
      "category",
      "Filed in a category",
      "required",
      input.categoryPath.length > 0,
      input.categoryPath.join(" › ") || "none",
      "The category name is part of the search index.",
    ),
    check(
      "search_terms",
      "At least three search terms",
      "recommended",
      input.searchKeywords.length >= 3,
      `${input.searchKeywords.length} recorded`,
      "Other names, spacing variants and the typos shoppers really use.",
    ),
    check(
      "tags",
      "At least three tags",
      "optional",
      input.tags.length >= 3,
      `${input.tags.length} recorded`,
      "Tags feed both search and the related-products row.",
    ),
    check(
      "attributes",
      "At least two specifications to filter on",
      "recommended",
      specificationCount(input) >= 2,
      `${specificationCount(input)} recorded`,
      "Colour, size and material are words shoppers type.",
    ),
  ];

  return summarise(checks);
}
