import { getLocalServicesConfig, localRequest, localServiceUrl, type LocalServicesConfig } from "./config";

/**
 * A minimal client for Ollama's local HTTP API (D-124).
 *
 * Two calls only: `/api/tags` to learn which models are installed, and
 * `/api/chat` with `format` set to a JSON schema, which Ollama uses to
 * constrain the model's output. That constraint is a convenience, not a
 * guarantee Manifest relies on: every caller still parses and validates what
 * comes back, and a malformed answer is a failure, never a partial success.
 *
 * No API key exists or is sent. The base address must be loopback unless the
 * owner explicitly allowed a remote one (`localServiceUrl`), and there is no
 * fallback to any other service: when Ollama is not answering, the caller is
 * told so and decides what to do without AI.
 */

export type OllamaChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OllamaChatResult =
  | { ok: true; content: string; model: string; inputTokens: number | null; outputTokens: number | null; truncated: boolean }
  | { ok: false; kind: "refused_address" | "unreachable" | "timeout" | "model_missing" | "error"; message: string };

/** The whole answer is JSON text; a product analysis is a few tens of kilobytes at most. */
const MAX_CHAT_BYTES = 2 * 1024 * 1024;
const MAX_TAGS_BYTES = 512 * 1024;

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly allowRemote: boolean,
    private readonly timeoutMs: number,
    private readonly numCtx: number,
  ) {}

  static fromConfig(config: LocalServicesConfig = getLocalServicesConfig()): OllamaClient {
    return new OllamaClient(config.OLLAMA_BASE_URL, config.OLLAMA_ALLOW_REMOTE, config.OLLAMA_TIMEOUT_MS, config.OLLAMA_NUM_CTX);
  }

  private endpoint(path: string): URL | { refused: string } {
    const base = localServiceUrl(this.baseUrl, this.allowRemote);
    if (!base.ok) return { refused: `OLLAMA_BASE_URL is refused: ${base.reason}.` };
    return new URL(path, base.url);
  }

  /** The installed models, or why they could not be listed. */
  async models(timeoutMs = 2_000): Promise<{ ok: true; names: string[] } | { ok: false; kind: "refused_address" | "unreachable" | "timeout" | "error"; message: string }> {
    const url = this.endpoint("api/tags");
    if ("refused" in url) return { ok: false, kind: "refused_address", message: url.refused };
    const result = await localRequest(url, { timeoutMs, maxBytes: MAX_TAGS_BYTES });
    if (!result.ok) return { ok: false, kind: result.kind === "timeout" ? "timeout" : result.kind === "unreachable" ? "unreachable" : "error", message: `Ollama: ${result.message}.` };
    if (result.status !== 200) return { ok: false, kind: "error", message: `Ollama answered ${result.status}.` };
    try {
      const parsed = JSON.parse(result.text) as { models?: { name?: unknown; model?: unknown }[] };
      const names = (parsed.models ?? [])
        .flatMap((entry) => [entry.name, entry.model])
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      return { ok: true, names: [...new Set(names)] };
    } catch {
      return { ok: false, kind: "error", message: "Ollama's model list could not be read." };
    }
  }

  async chat(request: {
    model: string;
    messages: OllamaChatMessage[];
    schema: unknown;
    maxOutputTokens: number;
  }): Promise<OllamaChatResult> {
    const url = this.endpoint("api/chat");
    if ("refused" in url) return { ok: false, kind: "refused_address", message: url.refused };
    const result = await localRequest(url, {
      method: "POST",
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_CHAT_BYTES,
      body: {
        model: request.model,
        messages: request.messages,
        stream: false,
        format: request.schema,
        // Reading and writing from given facts, not creativity.
        options: { temperature: 0, num_ctx: this.numCtx, num_predict: request.maxOutputTokens },
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind === "timeout" ? "timeout" : result.kind === "unreachable" ? "unreachable" : "error",
        message: `Ollama: ${result.message}.`,
      };
    }
    if (result.status === 404) {
      return { ok: false, kind: "model_missing", message: `The model "${request.model}" is not installed in Ollama (run: ollama pull ${request.model}).` };
    }
    if (result.status !== 200) return { ok: false, kind: "error", message: `Ollama answered ${result.status}.` };

    let parsed: { message?: { content?: unknown }; model?: unknown; prompt_eval_count?: unknown; eval_count?: unknown; done_reason?: unknown };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { ok: false, kind: "error", message: "Ollama's answer could not be read." };
    }
    const content = parsed.message?.content;
    if (typeof content !== "string") return { ok: false, kind: "error", message: "Ollama returned no answer." };
    return {
      ok: true,
      content,
      model: typeof parsed.model === "string" ? parsed.model : request.model,
      inputTokens: typeof parsed.prompt_eval_count === "number" ? parsed.prompt_eval_count : null,
      outputTokens: typeof parsed.eval_count === "number" ? parsed.eval_count : null,
      truncated: parsed.done_reason === "length",
    };
  }
}

/** Whether a configured model name is among the installed ones ("llama3.1" is "llama3.1:latest"). */
export function modelInstalled(configured: string, installed: string[]): boolean {
  const wanted = configured.trim().toLowerCase();
  const withTag = wanted.includes(":") ? wanted : `${wanted}:latest`;
  return installed.some((name) => {
    const have = name.trim().toLowerCase();
    return have === wanted || have === withTag;
  });
}

/**
 * Parses a structured answer and checks it with `accept`. On failure, asks
 * once more — telling the model what was wrong — and gives up after that.
 * Never loops, never repairs, never keeps part of a broken answer.
 */
export async function chatJson<T>(
  client: OllamaClient,
  request: { model: string; messages: OllamaChatMessage[]; schema: unknown; maxOutputTokens: number },
  accept: (raw: unknown) => T | null,
): Promise<
  | { ok: true; value: T; model: string; inputTokens: number | null; outputTokens: number | null; attempts: number }
  | { ok: false; kind: "refused_address" | "unreachable" | "timeout" | "model_missing" | "error" | "malformed"; message: string }
> {
  let messages = request.messages;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const answer = await client.chat({ ...request, messages });
    if (!answer.ok) return answer;
    inputTokens += answer.inputTokens ?? 0;
    outputTokens += answer.outputTokens ?? 0;
    let problem: string;
    if (answer.truncated) {
      problem = "Your answer was cut off before it finished.";
    } else {
      let raw: unknown;
      let parsedOk = true;
      try {
        raw = JSON.parse(answer.content);
      } catch {
        parsedOk = false;
      }
      const value = parsedOk ? accept(raw) : null;
      if (value !== null) {
        return { ok: true, value, model: answer.model, inputTokens: inputTokens || null, outputTokens: outputTokens || null, attempts: attempt };
      }
      problem = parsedOk ? "Your answer did not match the required JSON schema." : "Your answer was not valid JSON.";
    }
    if (attempt === 2) break;
    messages = [
      ...request.messages,
      { role: "assistant", content: answer.content.slice(0, 4_000) },
      { role: "user", content: `${problem} Answer again with only one JSON object that matches the schema. Do not add anything the source does not state.` },
    ];
  }
  return { ok: false, kind: "malformed", message: "The local model's answer was not valid structured JSON, twice." };
}
