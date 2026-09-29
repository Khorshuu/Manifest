import { z } from "zod";

/**
 * Settings for the services that run on the owner's own machine (D-124):
 * Ollama for local AI, an optional SearXNG instance for local web search, and
 * an optional Playwright/Chromium page renderer.
 *
 * None of them is required. Each one that is absent or not running degrades to
 * what Manifest already does without it — the structured readers, the rules
 * generator, the Brand Source Registry and sitemaps, the static fetcher — and
 * says so. None of them has, or needs, an API key.
 *
 * Read separately from lib/env.ts, like SEO Pulse's settings, so both the
 * research pipeline and SEO Pulse can depend on it without depending on each
 * other.
 */

const flag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .optional()
  .transform((value) => value === "true" || value === "1" || value === "yes");

const schema = z.object({
  OLLAMA_BASE_URL: z.string().min(1).default("http://127.0.0.1:11434"),
  /** One model for everything, unless one of the two below is set. Never defaulted: the owner chooses. */
  OLLAMA_MODEL: z.string().min(1).optional(),
  OLLAMA_EXTRACTION_MODEL: z.string().min(1).optional(),
  OLLAMA_SEO_MODEL: z.string().min(1).optional(),
  /**
   * Explicit opt-in to an Ollama that is not on this machine (a LAN box). Off
   * by default: product documents are only ever sent to a loopback address
   * unless the owner says otherwise here.
   */
  OLLAMA_ALLOW_REMOTE: flag,
  /** Local inference is slow on ordinary hardware; one answer may take minutes. */
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(240_000),
  /** Context window asked of the model. Ollama's own default is too small for a product page. */
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2_048).max(262_144).default(16_384),
  /**
   * How many heavy local-model calls may run at once on this machine (D-127).
   * One by default: two 7B generations at once on ordinary hardware compete
   * for the same graphics memory and both slow down or fail. Stronger
   * hardware may raise it; it is bounded so a typo cannot start a stampede.
   */
  LOCAL_AI_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /**
   * How long a local-model call waits for a free slot before giving up with
   * OLLAMA_QUEUE_WAIT_TIMEOUT. Unset: long enough for one other call to
   * finish both of its attempts (`localAiRuntime`).
   */
  LOCAL_AI_QUEUE_WAIT_MS: z.coerce.number().int().min(1_000).max(7_200_000).optional(),
  SEARXNG_BASE_URL: z.string().min(1).optional(),
  SEARXNG_ALLOW_REMOTE: flag,
  /** `none` (default): static fetch only. `playwright`: render a JavaScript-only page when the static copy is an empty shell. */
  LOCAL_BROWSER_RENDERER: z.enum(["none", "playwright"]).default("none"),
});

export type LocalServicesConfig = z.infer<typeof schema>;

export function getLocalServicesConfig(): LocalServicesConfig {
  // Blank values mean "not set", as elsewhere.
  const values = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
  );
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid local services configuration: ${issues}`);
  }
  return parsed.data;
}

/** Attempts `chatJson` makes at most: the answer, and one request to correct it. */
export const LOCAL_AI_ATTEMPTS = 2;
/** Room for reading the answer, validating it and writing the run, beyond the model's own time. */
const LOCAL_AI_MARGIN_MS = 5 * 60_000;

/**
 * How long local-model work may legitimately take (D-127), derived from the
 * configured timeout rather than from any one machine:
 *
 *  - `callMs` — one `chatJson` call at its worst: every attempt running to
 *    OLLAMA_TIMEOUT_MS, plus a margin.
 *  - `queueWaitMs` — how long a call waits for a free slot: by default one
 *    other call's worst case, so the second of two queued calls still runs.
 *  - `jobMs` — a background job that makes one such call, including the wait.
 *
 * Stale-run and stale-job detection use these, so a real ten-minute
 * generation is never mistaken for an abandoned one, and a genuinely dead one
 * still becomes recoverable once this much time has passed without progress.
 */
export function localAiRuntime(config: LocalServicesConfig = getLocalServicesConfig()) {
  const callMs = config.OLLAMA_TIMEOUT_MS * LOCAL_AI_ATTEMPTS + LOCAL_AI_MARGIN_MS;
  const queueWaitMs = config.LOCAL_AI_QUEUE_WAIT_MS ?? callMs;
  return { callMs, queueWaitMs, jobMs: callMs + queueWaitMs, concurrency: config.LOCAL_AI_CONCURRENCY };
}

export function ollamaModelFor(config: LocalServicesConfig, use: "extraction" | "seo"): string | null {
  return (use === "extraction" ? config.OLLAMA_EXTRACTION_MODEL : config.OLLAMA_SEO_MODEL) ?? config.OLLAMA_MODEL ?? null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type LocalServiceUrl = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * The base address of a local service, or why it is refused.
 *
 * Only loopback hosts are accepted unless the owner opted in to a remote one.
 * This is what keeps "local AI" local: a mistyped or copied address pointing
 * at a hosted, OpenAI-compatible endpoint would otherwise receive every
 * product document without anyone noticing. Credentials in the address are
 * refused either way, and only http(s) is spoken.
 */
export function localServiceUrl(raw: string, allowRemote: boolean): LocalServiceUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "the address is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `${url.protocol} is not allowed` };
  if (url.username || url.password) return { ok: false, reason: "addresses with credentials are refused" };
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return {
      ok: false,
      reason: `${url.hostname} is not this computer; only 127.0.0.1, localhost or ::1 are used unless remote use is explicitly allowed`,
    };
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { ok: true, url };
}

/**
 * One bounded request to a local service. No redirects are followed (a
 * redirect is how a loopback address could hand a request to somewhere else),
 * the answer is size-capped, and the caller gets the text or a typed failure —
 * never an exception for an ordinary outage.
 */
export type LocalRequestResult =
  | { ok: true; status: number; text: string }
  | { ok: false; kind: "unreachable" | "timeout" | "too_large" | "redirect"; message: string };

export async function localRequest(
  url: URL,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; maxBytes: number; accept?: string },
): Promise<LocalRequestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: {
        accept: init.accept ?? "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { ok: false, kind: "redirect", message: "the service answered with a redirect, which is not followed" };
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > init.maxBytes) {
          await reader.cancel();
          return { ok: false, kind: "too_large", message: "the service's answer was larger than expected" };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: response.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    return aborted
      ? { ok: false, kind: "timeout", message: "the service did not answer in time" }
      : { ok: false, kind: "unreachable", message: "the service is not running or could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}
