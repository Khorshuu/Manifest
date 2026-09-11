import {
  generatedSchema,
  KEYWORD_INTENTS,
  type GeneratedRecommendations,
  type KeywordRecommendation,
  type SeoPulseInput,
} from "./types";
import { clampText, cleanTerms, dedupeBy, keywordKey, normalizeKeyword, suggestSlug } from "./text";

/**
 * Turns whatever a generator returned into something safe to store.
 *
 * An AI response is untrusted input. It is cut to length, deduplicated,
 * stripped of any image id that does not belong to this product, given a
 * valid slug, and then parsed against the strict schema. Anything still
 * invalid after cleaning throws — the caller falls back to the rules
 * generator rather than saving a half-valid analysis.
 */

type Loose = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Loose =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {};

function cleanKeyword(value: unknown): KeywordRecommendation | null {
  const entry = obj(value);
  const keyword = normalizeKeyword(str(entry.keyword)).slice(0, 80);
  if (keyword.length < 2) return null;
  const intent = (KEYWORD_INTENTS as readonly string[]).includes(str(entry.intent))
    ? (entry.intent as KeywordRecommendation["intent"])
    : "product";
  const relevance = ["high", "medium", "low"].includes(str(entry.relevance))
    ? (entry.relevance as KeywordRecommendation["relevance"])
    : "medium";
  const reason = clampText(str(entry.reason), 300) || "Suggested by SEO Pulse analysis.";
  return { keyword, intent, relevance, reason };
}

function cleanKeywords(values: unknown, max: number, exclude: Set<string>) {
  return dedupeBy(
    arr(values)
      .map(cleanKeyword)
      .filter((item): item is KeywordRecommendation => item !== null),
    (item) => keywordKey(item.keyword),
  )
    .filter((item) => !exclude.has(keywordKey(item.keyword)))
    .slice(0, max);
}

export function sanitizeGenerated(
  raw: unknown,
  input: SeoPulseInput,
): GeneratedRecommendations {
  const source = obj(raw);

  const primary = cleanKeyword(source.primaryKeyword);
  if (!primary) throw new Error("The analysis did not include a primary keyword.");
  const primaryKey = keywordKey(primary.keyword);

  const secondaryKeywords = cleanKeywords(source.secondaryKeywords, 10, new Set([primaryKey]));
  const longTailKeywords = cleanKeywords(
    source.longTailKeywords,
    10,
    new Set([primaryKey, ...secondaryKeywords.map((item) => keywordKey(item.keyword))]),
  );

  const title = obj(source.seoTitle);
  const meta = obj(source.metaDescription);
  const h1 = obj(source.h1);
  const slug = obj(source.slug);
  const description = obj(source.description);

  const imageIds = new Set(input.images.map((image) => image.id));
  const imageAlts = dedupeBy(
    arr(source.imageAlts)
      .map(obj)
      .filter((entry) => imageIds.has(str(entry.imageId)))
      .map((entry) => ({
        imageId: str(entry.imageId),
        altText: clampText(str(entry.altText), 125),
        title: clampText(str(entry.title), 120) || null,
        // The model is never shown the photographs, so it cannot vouch for them.
        needsReview: true,
        reason:
          clampText(str(entry.reason), 300) ||
          "Written from the product data, not from the photograph. Check it describes what is shown.",
      }))
      .filter((entry) => entry.altText.length > 0),
    (entry) => entry.imageId,
  );

  const recommendedSlug = suggestSlug(str(slug.recommended) || input.title);

  const cleaned = {
    primaryKeyword: primary,
    secondaryKeywords,
    longTailKeywords,
    synonyms: cleanTerms(arr(source.synonyms).map(str), 15),
    relatedTerms: cleanTerms(arr(source.relatedTerms).map(str), 15),
    searchAliases: cleanTerms(arr(source.searchAliases).map(str), 15),
    misspellings: dedupeBy(
      arr(source.misspellings)
        .map(obj)
        .map((entry) => ({
          term: normalizeKeyword(str(entry.term)).slice(0, 60),
          basis: clampText(str(entry.basis), 200) || "AI-generated — not observed in real searches.",
        }))
        .filter((entry) => entry.term.length >= 2),
      (entry) => keywordKey(entry.term),
    ).slice(0, 10),
    searchPhrases: cleanTerms(arr(source.searchPhrases).map(str), 10),
    brandVariations: cleanTerms(arr(source.brandVariations).map(str), 8),
    seoTitle: {
      recommended: clampText(str(title.recommended), 70),
      alternatives: dedupeBy(
        arr(title.alternatives).map((value) => clampText(str(value), 70)).filter(Boolean),
        (value) => value.toLowerCase(),
      ).slice(0, 3),
      reason: clampText(str(title.reason), 300) || "Suggested by SEO Pulse analysis.",
    },
    metaDescription: {
      recommended: clampText(str(meta.recommended), 170),
      reason: clampText(str(meta.reason), 300) || "Suggested by SEO Pulse analysis.",
    },
    h1: {
      recommended: clampText(str(h1.recommended) || input.title, 200),
      reason: clampText(str(h1.reason), 300) || "Suggested by SEO Pulse analysis.",
    },
    slug: {
      recommended: recommendedSlug,
      reason: clampText(str(slug.reason), 300) || "Lowercase, hyphenated, without filler words.",
    },
    description: {
      improvements: arr(description.improvements)
        .map((value) => clampText(str(value), 300))
        .filter(Boolean)
        .slice(0, 10),
      suggestedHtml: str(description.suggestedHtml).trim().slice(0, 8000) || null,
    },
    tags: cleanTerms(arr(source.tags).map(str), 12, 40),
    keyFeatures: dedupeBy(
      arr(source.keyFeatures)
        .map((value) => clampText(str(value), 300))
        .filter(Boolean),
      (value) => value.toLowerCase(),
    ).slice(0, 10),
    imageAlts,
    faqs: arr(source.faqs)
      .map(obj)
      .map((entry) => {
        const answer = clampText(str(entry.answer), 600) || null;
        return {
          question: clampText(str(entry.question), 200),
          answer,
          needsManualAnswer: answer === null || entry.needsManualAnswer === true,
          basis: clampText(str(entry.basis), 200) || "AI-generated.",
        };
      })
      .filter((entry) => entry.question.length > 0)
      .slice(0, 8),
    categoryNotes: arr(source.categoryNotes)
      .map((value) => clampText(str(value), 300))
      .filter(Boolean)
      .slice(0, 5),
  };

  const parsed = generatedSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `The analysis failed validation at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

/**
 * Removes anything unsafe from suggested description HTML: scripts, styles,
 * event handlers, and any tag outside a short list of text formatting.
 */
export function sanitizeDescriptionHtml(html: string): string {
  const allowed = new Set(["p", "h2", "h3", "ul", "ol", "li", "strong", "em", "b", "i", "br"]);
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (tag, name: string) => {
      const lower = name.toLowerCase();
      if (!allowed.has(lower)) return "";
      return tag.startsWith("</") ? `</${lower}>` : `<${lower}>`;
    })
    .trim();
}
