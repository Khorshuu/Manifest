import { getLocalServicesConfig, ollamaModelFor } from "@/lib/providers/local/config";
import { chatJson, localAiFailureCode, OllamaClient } from "@/lib/providers/local/ollama";
import { documentBlock, MAX_TEXT, readCandidates, requestContext, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";
import type { DocumentExtractionRequest, DocumentExtractionResult, ProductDocumentExtractionProvider } from "./types";

/**
 * A local model, through Ollama on the owner's own computer, reading one
 * document Manifest retrieved (D-124).
 *
 * Asked exactly what the Anthropic provider is asked (`./prompt`), answering in
 * the same schema, and trusted exactly as little: its candidates are reduced
 * by `readCandidates` and then every one must survive `groundCandidates()`
 * against the page's own text before it can even become a proposal. The model
 * is not evidence; the page's excerpt is.
 *
 * No key, no cloud. The base address must be loopback unless the owner opted
 * in to a remote Ollama, and when Ollama is not running this reports
 * UNAVAILABLE — there is no fallback to any other service. A malformed answer
 * is asked for once more and then reported FAILED; nothing from it is kept.
 */

/** Tokens the answer may use: 40 candidates of a short label, value and excerpt fit comfortably. */
const MAX_OUTPUT_TOKENS = 4_096;
/** The instructions and context lines, in tokens, roughly. */
const PROMPT_TOKENS = 1_500;

/** Characters of document the context window leaves room for, at about three characters a token. */
export function documentBudget(numCtx: number): number {
  return Math.min(MAX_TEXT, Math.max(6_000, (numCtx - MAX_OUTPUT_TOKENS - PROMPT_TOKENS) * 3));
}

/** The answer's outer shape. The entries are reduced separately; this only refuses a non-answer. */
function acceptAnswer(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Array.isArray((raw as { candidates?: unknown }).candidates) ? raw : null;
}

export class OllamaExtractionProvider implements ProductDocumentExtractionProvider {
  readonly key = "ollama";

  constructor(
    private readonly client: OllamaClient,
    private readonly model: string | null,
    private readonly numCtx: number,
  ) {}

  static fromConfig(): OllamaExtractionProvider {
    const config = getLocalServicesConfig();
    return new OllamaExtractionProvider(OllamaClient.fromConfig(config), ollamaModelFor(config, "extraction"), config.OLLAMA_NUM_CTX);
  }

  async extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult> {
    if (!this.model) {
      return { status: "UNAVAILABLE", message: "No local model is chosen: set OLLAMA_MODEL (or OLLAMA_EXTRACTION_MODEL) to a model installed in Ollama." };
    }
    const answer = await chatJson(
      this.client,
      {
        model: this.model,
        schema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${requestContext(request)}\n\n${documentBlock(request, documentBudget(this.numCtx))}` },
        ],
      },
      acceptAnswer,
    );
    if (!answer.ok) {
      // Ollama not answering, too slow, busy past the queue wait, or without
      // the model: the page may be read later. A broken answer is a failure.
      const unavailable =
        answer.kind === "unreachable" ||
        answer.kind === "timeout" ||
        answer.kind === "model_missing" ||
        answer.kind === "refused_address" ||
        answer.kind === "queue_timeout";
      return { status: unavailable ? "UNAVAILABLE" : "FAILED", message: answer.message, code: localAiFailureCode(answer.kind) };
    }
    return {
      status: "OK",
      candidates: readCandidates(answer.value, request.maxCandidates),
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    };
  }
}
