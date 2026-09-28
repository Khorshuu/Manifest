import { getLocalServicesConfig, ollamaModelFor } from "@/lib/providers/local/config";
import { chatJson, OllamaClient } from "@/lib/providers/local/ollama";
import { generateByRules } from "../rules";
import { measurementRows, specificationRows } from "../facts";
import { sanitizeDescriptionHtml, sanitizeGenerated } from "../sanitize";
import type { GeneratedRecommendations, SeoPulseInput, SeoResearchData } from "../types";
import type { IntelligenceResult, SeoIntelligenceProvider } from "./intelligence";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";

/**
 * SEO Pulse's content written by a model on the owner's own computer, through
 * Ollama (D-124).
 *
 * Same rules and answer schema as the hosted provider (`./prompt`), and the
 * same cleaning: the answer goes through `sanitizeGenerated` before anything
 * is kept, and the run's usual ownership rules decide what may be written
 * (staff-owned and locked fields are never touched by any generator).
 *
 * What differs is what the model is shown. A local model is given only
 * `groundedPromptInput`: the product's name, brand and category; the
 * specification and measurement rows SEO Pulse itself treats as established
 * (`specificationRows` / `measurementRows`: what staff entered on the listing,
 * plus the knowledge base's VERIFIED or MANUAL values from
 * `groundedKnowledge()`); staff-written key features, box contents and
 * description; the family's schema; and the site's own search data. It is not
 * given SEO Pulse's own earlier wording (D-120), offer terms, or anything
 * suggested and unaccepted — none of that is established, and a model would
 * restate it as fact.
 *
 * And what it writes is held to the facts it was given: a figure the name and
 * the established facts do not contain — "30-hour battery" when no battery
 * life is established — is withheld (`withholdUnsupportedFigures`); the
 * field falls back to the rules generator's wording or is left out, and the
 * description's improvements say so.
 *
 * Failure throws, as every AI provider does; SEO Pulse then records the
 * failure and uses the rules generator, which is also local. It never falls
 * back to a hosted model, and a rules result is labelled as rules, so nothing
 * claims AI copy was written when it was not.
 */

const MAX_OUTPUT_TOKENS = 6_000;

/** The product as a local model may see it: established knowledge and naming, nothing else. */
/** Terms of the offer, never product facts (I-8). */
const OFFER_LABEL = /^(price|sale price|regular price|availability|stock|in stock|shipping|delivery|warranty)$/i;

export function groundedPromptInput(input: SeoPulseInput) {
  const knowledge = input.knowledge;
  return {
    product: {
      title: input.title,
      name: knowledge.name,
      brand: knowledge.brand ?? input.brand,
      modelName: knowledge.modelName,
      categoryPath: input.categoryPath,
      family: knowledge.family?.name ?? null,
      slug: input.slug,
    },
    // What staff entered and what the knowledge base established; never an offer term.
    establishedFacts: [
      ...specificationRows(input).map((row) => ({ ...row, scope: "product" })),
      ...measurementRows(input).map((row) => ({ ...row, scope: "product" })),
      ...knowledge.attributes
        .filter((attribute) => attribute.pkbVariantId !== null)
        .map((attribute) => ({ label: attribute.label, value: attribute.unit && !attribute.value.includes(attribute.unit) ? `${attribute.value} ${attribute.unit}` : attribute.value, scope: "one version" })),
    ].filter((row) => !OFFER_LABEL.test(row.label.trim())),
    // Staff's own words only: SEO Pulse's earlier wording is not evidence (D-120).
    staffKeyFeatures: input.pulseWritten?.bulletFeatures ? [] : input.bulletFeatures,
    staffDescription: input.pulseWritten?.description ? "" : input.descriptionText.slice(0, 4_000),
    boxContents: input.boxContents,
    identifiers: knowledge.identifiers,
    relationships: knowledge.relationships,
    familySchema: knowledge.family?.attributes.map((attribute) => attribute.label) ?? [],
    images: input.images.map((image) => ({ imageId: image.id, currentAltText: image.altText, kind: image.kind })),
    // How the listing is found today: search wording, not product facts.
    currentSearchTerms: { focusKeyword: input.seoFocusKeyword, tags: input.tags, searchKeywords: input.searchKeywords },
  };
}

const FIGURE = /\d+(?:[.,]\d+)*/g;

function figures(text: string): string[] {
  return (text.match(FIGURE) ?? []).map((figure) => figure.replace(/,/g, "").replace(/^0+(?=\d)/, ""));
}

/** Every figure the product's naming and established facts contain. */
export function supportedFigures(input: SeoPulseInput): Set<string> {
  const view = groundedPromptInput(input);
  const sources = [
    view.product.title,
    view.product.name ?? "",
    view.product.brand ?? "",
    view.product.modelName ?? "",
    ...view.product.categoryPath,
    ...view.establishedFacts.flatMap((fact) => [fact.label, fact.value]),
    ...view.staffKeyFeatures,
    view.staffDescription,
    ...view.boxContents,
    ...view.identifiers.map((identifier) => JSON.stringify(identifier)),
  ];
  return new Set(sources.flatMap(figures));
}

/**
 * Withholds anything the model wrote that states a figure the facts do not
 * (D-124). Text without figures is left to the prompt's rules and to review;
 * a number is the one kind of invention that can be caught mechanically, and
 * the one a shopper relies on most.
 */
export function withholdUnsupportedFigures(
  generated: GeneratedRecommendations,
  input: SeoPulseInput,
  fallback: () => GeneratedRecommendations,
): { generated: GeneratedRecommendations; withheld: string[] } {
  const allowed = supportedFigures(input);
  const supported = (text: string | null | undefined) => figures(text ?? "").every((figure) => allowed.has(figure));
  const withheld: string[] = [];
  const keep = <T>(list: T[], text: (item: T) => string, what: string): T[] => {
    const kept = list.filter((item) => supported(text(item)));
    if (kept.length < list.length) withheld.push(what);
    return kept;
  };
  const out: GeneratedRecommendations = structuredClone(generated);

  if (!supported(out.primaryKeyword.keyword)) {
    out.primaryKeyword = fallback().primaryKeyword;
    withheld.push("primary keyword");
  }
  out.secondaryKeywords = keep(out.secondaryKeywords, (item) => item.keyword, "keywords");
  out.longTailKeywords = keep(out.longTailKeywords, (item) => item.keyword, "keywords");
  out.synonyms = keep(out.synonyms, (item) => item, "synonyms");
  out.relatedTerms = keep(out.relatedTerms, (item) => item, "related terms");
  out.searchAliases = keep(out.searchAliases, (item) => item, "search aliases");
  out.searchPhrases = keep(out.searchPhrases, (item) => item, "search phrases");
  out.misspellings = keep(out.misspellings, (item) => item.term, "misspellings");
  out.brandVariations = keep(out.brandVariations, (item) => item, "brand variations");
  out.tags = keep(out.tags, (item) => item, "tags");
  out.keyFeatures = keep(out.keyFeatures, (item) => item, "key features");
  out.seoTitle.alternatives = keep(out.seoTitle.alternatives, (item) => item, "title alternatives");
  if (!supported(out.seoTitle.recommended)) {
    out.seoTitle = { ...fallback().seoTitle, alternatives: out.seoTitle.alternatives };
    withheld.push("SEO title");
  }
  if (!supported(out.metaDescription.recommended)) {
    out.metaDescription = fallback().metaDescription;
    withheld.push("meta description");
  }
  if (!supported(out.h1.recommended)) {
    out.h1 = fallback().h1;
    withheld.push("H1");
  }
  out.faqs = out.faqs.map((faq) =>
    supported(faq.answer) ? faq : { ...faq, answer: null, needsManualAnswer: true, basis: "The drafted answer stated a figure the verified facts do not contain." },
  );
  if (out.description.suggestedHtml && !supported(sanitizeDescriptionHtml(out.description.suggestedHtml).replace(/<[^>]*>/g, " "))) {
    out.description.suggestedHtml = null;
    withheld.push("description");
  }
  const unique = [...new Set(withheld)];
  if (unique.length > 0) {
    out.description.improvements = [
      `The local model wrote figures the verified facts do not contain, so these were withheld: ${unique.join(", ")}.`.slice(0, 300),
      ...out.description.improvements,
    ].slice(0, 10);
  }
  return { generated: out, withheld: unique };
}

export class OllamaIntelligenceProvider implements SeoIntelligenceProvider {
  readonly id = "ollama";
  readonly kind = "ai" as const;
  /** On this computer, shown established knowledge only, figures checked (D-125). */
  readonly localGrounded = true;
  readonly label: string;

  constructor(
    private readonly client: OllamaClient,
    private readonly model: string,
  ) {
    this.label = `Local AI (Ollama — ${model})`;
  }

  static fromConfig(): OllamaIntelligenceProvider | null {
    const config = getLocalServicesConfig();
    const model = ollamaModelFor(config, "seo");
    return model ? new OllamaIntelligenceProvider(OllamaClient.fromConfig(config), model) : null;
  }

  async analyzeProduct(input: SeoPulseInput, research: SeoResearchData): Promise<IntelligenceResult> {
    const answer = await chatJson(
      this.client,
      {
        model: this.model,
        schema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "Product data (the established facts are the only product information you have; write nothing they do not support):",
              JSON.stringify(groundedPromptInput(input)),
              "",
              "Research collected:",
              JSON.stringify(research),
            ].join("\n"),
          },
        ],
      },
      (raw): GeneratedRecommendations | null => {
        // The same cleaning the hosted answer gets; an answer it cannot clean is malformed.
        try {
          return sanitizeGenerated(raw, input);
        } catch {
          return null;
        }
      },
    );
    if (!answer.ok) throw new Error(answer.message);
    let rules: GeneratedRecommendations | null = null;
    const { generated } = withholdUnsupportedFigures(answer.value, input, () => (rules ??= sanitizeGenerated(generateByRules(input, research), input)));
    return {
      generated,
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      // Runs on this computer: nothing is charged.
      estimatedCostUsd: 0,
    };
  }
}
