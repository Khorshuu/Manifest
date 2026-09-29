import { getLocalServicesConfig, LOCAL_AI_ATTEMPTS, localRequest, localServiceUrl, type LocalServicesConfig } from "./config";
import { LocalAiQueueTimeoutError, withLocalAiSlot } from "./slot";

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

/**
 * Why a call to the local model failed (D-127). `error` is Ollama itself
 * reporting a failure (a non-200 answer, or an error line in the stream);
 * `malformed` is an answer that could not be read, or never matched the
 * schema; `incomplete` is a stream that ended without saying it was done.
 */
export type OllamaFailureKind =
  | "refused_address"
  | "unreachable"
  | "timeout"
  | "model_missing"
  | "error"
  | "malformed"
  | "incomplete"
  | "queue_timeout";

export type OllamaChatResult =
  | { ok: true; content: string; model: string; inputTokens: number | null; outputTokens: number | null; truncated: boolean }
  | { ok: false; kind: Exclude<OllamaFailureKind, "queue_timeout">; message: string };

/** The code a failure is recorded under, for status screens, retries and preparation. */
export type LocalAiFailureCode =
  | "OLLAMA_UNAVAILABLE"
  | "OLLAMA_MODEL_NOT_FOUND"
  | "OLLAMA_GENERATION_TIMEOUT"
  | "OLLAMA_QUEUE_WAIT_TIMEOUT"
  | "OLLAMA_MALFORMED_RESPONSE"
  | "OLLAMA_INCOMPLETE_STREAM"
  | "OLLAMA_PROVIDER_ERROR";

export function localAiFailureCode(kind: OllamaFailureKind): LocalAiFailureCode {
  switch (kind) {
    case "refused_address":
    case "unreachable":
      return "OLLAMA_UNAVAILABLE";
    case "model_missing":
      return "OLLAMA_MODEL_NOT_FOUND";
    case "timeout":
      return "OLLAMA_GENERATION_TIMEOUT";
    case "queue_timeout":
      return "OLLAMA_QUEUE_WAIT_TIMEOUT";
    case "malformed":
      return "OLLAMA_MALFORMED_RESPONSE";
    case "incomplete":
      return "OLLAMA_INCOMPLETE_STREAM";
    case "error":
      return "OLLAMA_PROVIDER_ERROR";
  }
}

/**
 * A local-model failure, thrown by providers that throw (SeoPulse). The code
 * is kept on the run; the message is short and never carries the model's
 * answer.
 */
export class LocalAiError extends Error {
  readonly code: LocalAiFailureCode;
  constructor(kind: OllamaFailureKind, message: string) {
    super(message);
    this.name = "LocalAiError";
    this.code = localAiFailureCode(kind);
  }
}

/**
 * The whole streamed answer: about 150 bytes of framing per token, so the
 * 6,000-token cap on a SeoPulse answer is under 1 MB.
 */
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
        /*
         * Streamed, so the response headers arrive at once. Unstreamed, Ollama
         * sends nothing until the whole answer is written, and Node's fetch
         * gives up waiting for headers after 300 s whatever OLLAMA_TIMEOUT_MS
         * says — which a structured answer on ordinary hardware can exceed.
         * The answer is still read to the end and checked as one piece.
         */
        stream: true,
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

    return readChatStream(result.text, request.model);
  }
}

type ChatChunk = {
  message?: { content?: unknown };
  model?: unknown;
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
};

/**
 * Ollama's streamed chat answer: one JSON object per line, the text in
 * pieces, the counts and the reason it stopped on the last line. An answer
 * that reports an error, has an unreadable line or never says it is done is
 * a failure — nothing of it is used.
 */
export function readChatStream(text: string, model: string): OllamaChatResult {
  let content = "";
  let last: ChatChunk | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      return { ok: false, kind: "malformed", message: "Ollama's answer could not be read." };
    }
    if (chunk.error !== undefined) return { ok: false, kind: "error", message: "Ollama stopped with an error while answering." };
    const piece = chunk.message?.content;
    if (piece !== undefined && typeof piece !== "string") return { ok: false, kind: "malformed", message: "Ollama's answer could not be read." };
    content += piece ?? "";
    last = chunk;
  }
  if (!last || last.done !== true) return { ok: false, kind: "incomplete", message: "Ollama's answer ended before it was complete." };
  return {
    ok: true,
    content,
    model: typeof last.model === "string" ? last.model : model,
    inputTokens: typeof last.prompt_eval_count === "number" ? last.prompt_eval_count : null,
    outputTokens: typeof last.eval_count === "number" ? last.eval_count : null,
    truncated: last.done_reason === "length",
  };
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

export type ChatJsonResult<T> =
  | { ok: true; value: T; model: string; inputTokens: number | null; outputTokens: number | null; attempts: number }
  | { ok: false; kind: OllamaFailureKind; message: string };

/**
 * Parses a structured answer and checks it with `accept`. On failure, asks
 * once more — telling the model what was wrong — and gives up after that.
 * Never loops, never repairs, never keeps part of a broken answer.
 *
 * Both attempts run holding one local-AI slot (D-127), so no other heavy
 * local-model call starts between them, and the slot is released however
 * the call ends. Waiting too long for the slot is `queue_timeout`.
 */
export async function chatJson<T>(
  client: OllamaClient,
  request: { model: string; messages: OllamaChatMessage[]; schema: unknown; maxOutputTokens: number },
  accept: (raw: unknown) => T | null,
): Promise<ChatJsonResult<T>> {
  try {
    return await withLocalAiSlot(() => chatJsonHoldingSlot(client, request, accept));
  } catch (error) {
    if (error instanceof LocalAiQueueTimeoutError) return { ok: false, kind: "queue_timeout", message: error.message };
    throw error;
  }
}

async function chatJsonHoldingSlot<T>(
  client: OllamaClient,
  request: { model: string; messages: OllamaChatMessage[]; schema: unknown; maxOutputTokens: number },
  accept: (raw: unknown) => T | null,
): Promise<ChatJsonResult<T>> {
  let messages = request.messages;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 1; attempt <= LOCAL_AI_ATTEMPTS; attempt++) {
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
    if (attempt === LOCAL_AI_ATTEMPTS) break;
    messages = [
      ...request.messages,
      { role: "assistant", content: answer.content.slice(0, 4_000) },
      { role: "user", content: `${problem} Answer again with only one JSON object that matches the schema. Do not add anything the source does not state.` },
    ];
  }
  return { ok: false, kind: "malformed", message: "The local model's answer was not valid structured JSON, twice." };
}
