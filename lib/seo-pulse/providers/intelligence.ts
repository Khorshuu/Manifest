import Anthropic from "@anthropic-ai/sdk";
import { getSeoPulseConfig } from "../config";
import { generateByRules } from "../rules";
import { sanitizeGenerated } from "../sanitize";
import { OllamaIntelligenceProvider } from "./ollama";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";
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
 * the Anthropic provider is opt-in through SEO_PULSE_AI_PROVIDER, and so is
 * the local Ollama provider (D-124), which needs no key and costs nothing.
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
  /**
   * True only for a generator that runs on this computer, is shown nothing but
   * established knowledge (`groundedPromptInput`) and has its figures checked
   * against it (`withholdUnsupportedFigures`). Preparation may write its
   * wording into fields nobody else owns without a person reading it first
   * (D-125). A hosted model is never marked so.
   */
  readonly localGrounded?: boolean;
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
  // Local only: without a chosen model it is the rules generator, never a hosted one (D-124).
  if (env.SEO_PULSE_AI_PROVIDER === "ollama") {
    return OllamaIntelligenceProvider.fromConfig() ?? new RulesIntelligenceProvider();
  }
  return new RulesIntelligenceProvider();
}

export function describeIntelligenceProvider(): {
  configured: boolean;
  /** Whether a run spends money with this provider. */
  paid: boolean;
  /** Whether the AI runs on this computer (D-124). */
  local: boolean;
  label: string;
  note: string;
} {
  const env = getSeoPulseConfig();
  if (env.SEO_PULSE_AI_PROVIDER === "ollama") {
    const provider = OllamaIntelligenceProvider.fromConfig();
    return provider
      ? {
          configured: true,
          paid: false,
          local: true,
          label: provider.label,
          note: "Recommendations are written by a model running on this computer from verified knowledge only, then validated. If Ollama is not running, the rules generator is used and the run says so.",
        }
      : {
          configured: false,
          paid: false,
          local: true,
          label: "Local AI (no model chosen)",
          note: "SEO_PULSE_AI_PROVIDER is ollama but OLLAMA_MODEL is not set. The rules generator is used instead.",
        };
  }
  if (env.SEO_PULSE_AI_PROVIDER === "anthropic") {
    return env.ANTHROPIC_API_KEY
      ? {
          configured: true,
          paid: true,
          local: false,
          label: `Claude — ${env.SEO_PULSE_AI_MODEL}`,
          note: "Recommendations are AI-generated from the product data and research, then validated.",
        }
      : {
          configured: false,
          paid: false,
          local: false,
          label: "Claude (not configured)",
          note: "Selected, but ANTHROPIC_API_KEY is not set. The rules generator is used instead.",
        };
  }
  return {
    configured: true,
    paid: false,
    local: true,
    label: "SEO Pulse rules",
    note: "Recommendations are written by fixed rules from the product's own data. No AI, no cost. Set SEO_PULSE_AI_PROVIDER=ollama to use a local model, or anthropic to use Claude.",
  };
}

/** Test helper. */
export function setIntelligenceProviderForTesting(provider: SeoIntelligenceProvider | undefined) {
  override = provider;
}
