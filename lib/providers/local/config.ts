import { BlockList, isIP } from "node:net";
import { z } from "zod";

/**
 * Settings for the services Manifest runs for itself rather than buys (D-124):
 * Ollama for AI, an optional SearXNG instance for web search, and an optional
 * Playwright/Chromium page renderer. On a development machine they are on the
 * same computer; in a hosted environment they are private services beside the
 * worker (D-133). "Local" in these names means "ours", not "this computer".
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
   * Explicit opt-in to an Ollama that is not on this machine (a LAN box, or a
   * private GPU service in a hosted environment). Off by default: product
   * documents are only ever sent to a loopback address unless the owner says
   * otherwise here.
   */
  OLLAMA_ALLOW_REMOTE: flag,
  /**
   * Sent as `Authorization: Bearer` to an Ollama that sits behind a gateway
   * or reverse proxy (D-133). Ollama has no authentication of its own, so a
   * remote one must be either on a private network or behind something that
   * asks for this. Never sent over plain http outside a private network.
   */
  OLLAMA_AUTH_TOKEN: z.string().min(16).optional(),
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
  /**
   * How long the worker leaves a local-AI job queued while Ollama is not
   * answering, before running it anyway (D-134). A GPU that is restarting, or
   * one switched on for the work, is waited for instead of every run in the
   * meantime finishing with the rules generator's wording. After this long
   * the job runs and falls back as before, recorded as rules with the
   * failure it fell back from, so nothing waits for ever. 0: never wait.
   */
  LOCAL_AI_SERVICE_WAIT_MINUTES: z.coerce.number().int().min(0).max(1_440).default(30),
  SEARXNG_BASE_URL: z.string().min(1).optional(),
  SEARXNG_ALLOW_REMOTE: flag,
  /** As OLLAMA_AUTH_TOKEN, for a SearXNG behind a gateway. */
  SEARXNG_AUTH_TOKEN: z.string().min(16).optional(),
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

const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
// Carrier-grade NAT: what WireGuard-style overlay networks hand out.
privateRanges.addSubnet("100.64.0.0", 10, "ipv4");
// Unique local: private IPv6 networks, including a host's own.
privateRanges.addSubnet("fc00::", 7, "ipv6");

/**
 * Whether a host name can only be reached from inside a private network: a
 * private address written out, a single-label name (a service name on a
 * container network: `ollama`, `searxng`), or a name under `.internal` or
 * `.local`, which are reserved for private use and never resolve publicly.
 *
 * Judged from the name alone, with no lookup, so it is a statement about what
 * the operator wrote. Anything else is treated as reachable from the internet.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return privateRanges.check(host, "ipv4");
  if (family === 6) return privateRanges.check(host, "ipv6");
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (!host.includes(".")) return true;
  return host.endsWith(".internal") || host.endsWith(".local");
}

export type LocalServiceUrl = { ok: true; url: URL; remote: boolean } | { ok: false; reason: string };

/**
 * The base address of a local service, or why it is refused.
 *
 * Only loopback hosts are accepted unless the owner opted in to a remote one.
 * A reason never names the host: it reaches the health report, which carries
 * no address (lib/health.ts, D-134).
 * This is what keeps "local AI" local: a mistyped or copied address pointing
 * at a hosted, OpenAI-compatible endpoint would otherwise receive every
 * product document without anyone noticing. Credentials in the address are
 * refused either way, and only http(s) is spoken.
 *
 * A remote address that was opted in to must still be one of two things
 * (D-133): on a private network, where plain http is what these services
 * speak, or https. Product documents, and the gateway token when there is
 * one, are never sent in the clear across the public internet.
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
  const remote = !LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (remote && !allowRemote) {
    return {
      ok: false,
      reason: "the address is not this computer; only 127.0.0.1, localhost or ::1 are used unless remote use is explicitly allowed",
    };
  }
  if (remote && url.protocol !== "https:" && !isPrivateNetworkHost(url.hostname)) {
    return {
      ok: false,
      reason: "the address is outside a private network, so it must be reached over https",
    };
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { ok: true, url, remote };
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
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    timeoutMs: number;
    maxBytes: number;
    accept?: string;
    /** The gateway's bearer token, when the service sits behind one. Never logged, never in an error. */
    token?: string;
  },
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
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
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
