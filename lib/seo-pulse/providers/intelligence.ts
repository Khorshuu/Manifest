import Anthropic from "@anthropic-ai/sdk";
import { getSeoPulseConfig } from "../config";
import { generateByRules } from "../rules";
import { sanitizeGenerated } from "../sanitize";
import type {
  GeneratedRecommendations,
  SeoPulseInput,
  SeoResearchData,
} from "../types";

/**
 * Who writes the recommendations (DECISIONS.md D-038).
 *
 * An interface, so the AI vendor is one class rather than something threaded
 * through the feature. The rules provider always exists and costs nothing;
 * the Anthropic provider is opt-in through SEO_PULSE_AI_PROVIDER.
 */

export type IntelligenceResult = {
  generated: GeneratedRecommendations;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export interface SeoIntelligenceProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: "ai" | "rules";
  analyzeProduct(input: SeoPulseInput, research: SeoResearchData): Promise<IntelligenceResult>;
}

export class RulesIntelligenceProvider implements SeoIntelligenceProvider {
  readonly id = "rules";
  readonly label = "SEO Pulse rules";
  readonly kind = "rules" as const;

  async analyzeProduct(input: SeoPulseInput, research: SeoResearchData) {
    // Passed through the same cleaning as an AI answer, so both obey one schema.
    return {
      generated: sanitizeGenerated(generateByRules(input, research), input),
      model: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
    };
  }
}

/** Per million tokens, USD, for the models this is expected to run on. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const SYSTEM_PROMPT = `You are SEO Pulse, the product-SEO analyst for an online shop in Bangladesh that imports products from the United States and sells them at a fixed landed price, often on preorder.

You receive one product's data and any research that was actually collected (this site's own search log, and external keyword metrics or search results when a provider was configured). Write SEO and internal-search recommendations for this one product.

Rules:
- Never state a search volume, difficulty, CPC, ranking, traffic figure or trend. Numbers only ever come from the research you were given; do not repeat them as your own.
- Never promise rankings.
- Never invent product facts. Use only what the product data says. If something is unknown, leave it out or mark it for a manual answer.
- Prefer a few highly relevant keywords to many weak ones. No keyword stuffing.
- Use Bangladesh / BD / Dhaka terms only where local purchase intent genuinely applies (for example "price in Bangladesh"), not on every keyword.
- Misspellings: only ones shoppers plausibly type for this exact name. Say in "basis" that they are AI-suggested unless the research shows them.
- Synonyms must be true equivalents. A broad synonym that would match unrelated products is worse than none.
- You cannot see the product photographs. Alt text must be written from the product data and will be reviewed by staff; do not describe angles, backgrounds or scenes.
- FAQ answers only from the product data; otherwise answer null and set needsManualAnswer.
- SEO title: at most 50 characters (the site appends " · Manifest"). Meta description: 120–155 characters. Slug: lowercase words joined by single hyphens.
- The H1 should name the product plainly — usually the product name itself.
- suggestedHtml: a product description using only simple tags (p, h2, ul, li, strong). Base it on the product data; where the data is thin you may use well-established, widely published facts about this exact product (staff review everything before it is saved). Never invent prices, delivery dates, warranties or authenticity claims.
- keyFeatures: 3–6 short lines for the product page's key features, on the same basis as suggestedHtml. Empty if you cannot identify the product with confidence.
- Keep imageId values exactly as given.`;

/** The response shape, loosely typed: the strict check happens after cleaning. */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "primaryKeyword", "secondaryKeywords", "longTailKeywords", "synonyms",
    "relatedTerms", "searchAliases", "misspellings", "searchPhrases",
    "brandVariations", "seoTitle", "metaDescription", "h1", "slug",
    "description", "tags", "keyFeatures", "imageAlts", "faqs", "categoryNotes",
  ],
  properties: (() => {
    const keyword = {
      type: "object",
      additionalProperties: false,
      required: ["keyword", "intent", "relevance", "reason"],
      properties: {
        keyword: { type: "string" },
        intent: {
          type: "string",
          enum: ["informational", "commercial", "transactional", "navigational", "product", "use_case"],
        },
        relevance: { type: "string", enum: ["high", "medium", "low"] },
        reason: { type: "string" },
      },
    };
    const strings = { type: "array", items: { type: "string" } };
    const withReason = (extra: Record<string, unknown> = {}) => ({
      type: "object",
      additionalProperties: false,
      required: ["recommended", "reason", ...Object.keys(extra)],
      properties: { recommended: { type: "string" }, reason: { type: "string" }, ...extra },
    });
    return {
      primaryKeyword: keyword,
      secondaryKeywords: { type: "array", items: keyword },
      longTailKeywords: { type: "array", items: keyword },
      synonyms: strings,
      relatedTerms: strings,
      searchAliases: strings,
      misspellings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["term", "basis"],
          properties: { term: { type: "string" }, basis: { type: "string" } },
        },
      },
      searchPhrases: strings,
      brandVariations: strings,
      seoTitle: withReason({ alternatives: strings }),
      metaDescription: withReason(),
      h1: withReason(),
      slug: withReason(),
      description: {
        type: "object",
        additionalProperties: false,
        required: ["improvements", "suggestedHtml"],
        properties: {
          improvements: strings,
          suggestedHtml: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      tags: strings,
      keyFeatures: strings,
      imageAlts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["imageId", "altText", "title", "needsReview", "reason"],
          properties: {
            imageId: { type: "string" },
            altText: { type: "string" },
            title: { anyOf: [{ type: "string" }, { type: "null" }] },
            needsReview: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
      faqs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer", "needsManualAnswer", "basis"],
          properties: {
            question: { type: "string" },
            answer: { anyOf: [{ type: "string" }, { type: "null" }] },
            needsManualAnswer: { type: "boolean" },
            basis: { type: "string" },
          },
        },
      },
      categoryNotes: strings,
    };
  })(),
} as const;

/**
 * Claude, through the official SDK, with structured JSON output. The answer is
 * still cleaned and schema-checked (sanitizeGenerated) before anything is
 * kept — structured output guarantees a shape, not good content.
 *
 * UNVERIFIED — no API key was available while this was built.
 */
export class AnthropicIntelligenceProvider implements SeoIntelligenceProvider {
  readonly id = "anthropic";
  readonly label = "Claude (Anthropic)";
  readonly kind = "ai" as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });
  }

  async analyzeProduct(input: SeoPulseInput, research: SeoResearchData) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESPONSE_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Product data:\n${JSON.stringify(input)}\n\nResearch collected:\n${JSON.stringify(research)}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The AI provider declined this request.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The AI response was cut off before it finished.");
    }

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("The AI provider returned no analysis.");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(textBlock.text);
    } catch {
      throw new Error("The AI provider returned malformed JSON.");
    }

    const price = PRICES[this.model];
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      generated: sanitizeGenerated(raw, input),
      model: this.model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: price
        ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000
        : null,
    };
  }
}

let override: SeoIntelligenceProvider | undefined;

export function getIntelligenceProvider(): SeoIntelligenceProvider {
  if (override) return override;
  const env = getSeoPulseConfig();
  if (env.SEO_PULSE_AI_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
    return new AnthropicIntelligenceProvider(env.ANTHROPIC_API_KEY, env.SEO_PULSE_AI_MODEL);
  }
  return new RulesIntelligenceProvider();
}

export function describeIntelligenceProvider(): {
  configured: boolean;
  /** Whether a run spends money with this provider. */
  paid: boolean;
  label: string;
  note: string;
} {
  const env = getSeoPulseConfig();
  if (env.SEO_PULSE_AI_PROVIDER === "anthropic") {
    return env.ANTHROPIC_API_KEY
      ? {
          configured: true,
          paid: true,
          label: `Claude — ${env.SEO_PULSE_AI_MODEL}`,
          note: "Recommendations are AI-generated from the product data and research, then validated.",
        }
      : {
          configured: false,
          paid: false,
          label: "Claude (not configured)",
          note: "Selected, but ANTHROPIC_API_KEY is not set. The rules generator is used instead.",
        };
  }
  return {
    configured: true,
    paid: false,
    label: "SEO Pulse rules",
    note: "Recommendations are written by fixed rules from the product's own data. No AI, no cost. Set SEO_PULSE_AI_PROVIDER=anthropic to use Claude.",
  };
}

/** Test helper. */
export function setIntelligenceProviderForTesting(provider: SeoIntelligenceProvider | undefined) {
  override = provider;
}
