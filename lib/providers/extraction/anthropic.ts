import Anthropic from "@anthropic-ai/sdk";
import { documentBlock, MAX_TEXT, readCandidates, requestContext, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";
import {
  type DocumentExtractionRequest,
  type DocumentExtractionResult,
  type ProductDocumentExtractionProvider,
} from "./types";

/**
 * Claude, reading one document Manifest retrieved (D-123).
 *
 * It is told to quote, not to know. The answer is structured JSON, and it is
 * still only a list of pointers into the text: `lib/pkb/grounding.ts` throws
 * away any candidate whose excerpt is not in the document, whose value the
 * excerpt does not state, or whose numbers the excerpt does not contain.
 *
 * UNVERIFIED against the live API — no ANTHROPIC_API_KEY was available while
 * this was built. The request shape follows the SEO Pulse provider, which uses
 * the same SDK call; the tests drive the pipeline through a fake provider.
 */

export { readCandidates };

export class AnthropicExtractionProvider implements ProductDocumentExtractionProvider {
  readonly key = "anthropic";
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 }) : null;
  }

  async extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult> {
    if (!this.client) {
      return { status: "UNAVAILABLE", message: "ANTHROPIC_API_KEY is not set, so intelligent document extraction cannot run." };
    }

    const context = requestContext(request);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `${context}\n\n${documentBlock(request, MAX_TEXT)}`,
          },
        ],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return { status: "UNAVAILABLE", message: "The extraction service's rate limit was reached." };
      }
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return { status: "UNAVAILABLE", message: "The extraction service refused the configured credential." };
      }
      if (error instanceof Anthropic.APIConnectionError) {
        return { status: "UNAVAILABLE", message: "The extraction service could not be reached." };
      }
      if (error instanceof Anthropic.APIError) {
        return { status: "FAILED", message: `The extraction service answered ${error.status ?? "with an error"}.` };
      }
      throw error;
    }

    if (response.stop_reason === "refusal") return { status: "FAILED", message: "The extraction service declined this document." };
    if (response.stop_reason === "max_tokens") return { status: "FAILED", message: "The extraction answer was cut off." };
    const block = response.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") return { status: "FAILED", message: "The extraction service returned no answer." };

    let raw: unknown;
    try {
      raw = JSON.parse(block.text);
    } catch {
      return { status: "FAILED", message: "The extraction service returned malformed JSON." };
    }
    return {
      status: "OK",
      candidates: readCandidates(raw, request.maxCandidates),
      model: this.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
