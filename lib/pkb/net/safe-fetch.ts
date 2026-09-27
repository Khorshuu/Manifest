import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";
import { hostnameProblem, isPublicAddress } from "./address";

/**
 * The only way the knowledge base reaches the internet (D-073).
 *
 * - http and https only; no credentials in the address; standard ports only.
 * - The host name is resolved once, every resolved address must be public,
 *   and the connection is made to that vetted address. There is no second
 *   lookup a DNS rebinding answer could slip into.
 * - Redirects are followed by hand, at most three, each hop checked again;
 *   https never redirects down to http.
 * - A hard timeout on the whole exchange; a size cap on the decompressed body
 *   (a small compressed bomb is stopped at the cap); only document types the
 *   extractors read.
 * - No cookies, no authorization headers, a truthful User-Agent. A 401, 403
 *   or 429 is reported, never worked around.
 */

export type SafeFetchRefusal =
  | "INVALID_URL"
  | "PROTOCOL"
  | "CREDENTIALS"
  | "PORT"
  | "HOST"
  | "DNS"
  | "ADDRESS"
  | "REDIRECT"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "CONTENT_TYPE"
  | "HTTP_STATUS"
  | "NETWORK";

export type SafeFetchResult =
  | {
      ok: true;
      url: string;
      status: number;
      contentType: string;
      charset: string | null;
      body: Buffer;
      redirects: string[];
    }
  | { ok: false; code: SafeFetchRefusal; reason: string; status?: number; url: string };

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Lowercase media types accepted; others are refused before the body is read. */
  acceptTypes?: string[];
  userAgent?: string;
  /** Test seams. Production callers never pass these. */
  resolver?: Resolver;
  addressAllowed?: (address: string) => boolean;
  allowedPorts?: number[];
};

export const DEFAULT_ACCEPT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/json",
  "application/ld+json",
  "text/plain",
];

export const KNOWLEDGE_USER_AGENT =
  "ManifestKnowledgeBot/1.0 (product information retrieval; respects robots.txt)";

const defaultResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family === 6 ? 6 : 4 }));
};

function refusal(code: SafeFetchRefusal, reason: string, url: string, status?: number): SafeFetchResult {
  return { ok: false, code, reason, url, status };
}

type Checked = { url: URL; address: ResolvedAddress } | SafeFetchResult;

async function checkDestination(raw: string, options: Required<Pick<SafeFetchOptions, "resolver" | "addressAllowed" | "allowedPorts">>): Promise<Checked> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refusal("INVALID_URL", "not a valid address", raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refusal("PROTOCOL", `${url.protocol} is not allowed`, raw);
  }
  if (url.username || url.password) return refusal("CREDENTIALS", "addresses with credentials are refused", raw);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!options.allowedPorts.includes(port)) return refusal("PORT", `port ${port} is not allowed`, raw);

  const problem = hostnameProblem(url.hostname);
  if (problem) return refusal("HOST", `the host is ${problem}`, raw);

  let addresses: ResolvedAddress[];
  try {
    addresses = await options.resolver(url.hostname);
  } catch {
    return refusal("DNS", "the host name did not resolve", raw);
  }
  if (addresses.length === 0) return refusal("DNS", "the host name did not resolve", raw);
  // Every answer must be public: a mix is how rebinding tricks look.
  const unsafe = addresses.find((entry) => !options.addressAllowed(entry.address));
  if (unsafe) return refusal("ADDRESS", "the host resolves to a private, internal or reserved address", raw);
  return { url, address: addresses[0] };
}

function mediaType(header: string | undefined): { type: string; charset: string | null } {
  const [type = "", ...params] = (header ?? "").split(";");
  const charset = params
    .map((param) => param.trim())
    .find((param) => param.toLowerCase().startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/"/g, "")
    .trim();
  return { type: type.trim().toLowerCase(), charset: charset ? charset.toLowerCase() : null };
}

type Exchange =
  | { kind: "redirect"; location: string; status: number }
  | { kind: "response"; status: number; contentType: string; charset: string | null; body: Buffer }
  | { kind: "refused"; result: SafeFetchResult };

function exchange(
  target: { url: URL; address: ResolvedAddress },
  options: { maxBytes: number; acceptTypes: string[]; userAgent: string; signal: AbortSignal },
): Promise<Exchange> {
  const { url, address } = target;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Exchange) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal: options.signal,
        // The connection goes to the address already vetted; no second lookup.
        lookup: (_hostname, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
              { address: address.address, family: address.family },
            ]);
          } else {
            callback(null, address.address, address.family);
          }
        },
        servername: isIP(url.hostname) ? undefined : url.hostname,
        headers: {
          "user-agent": options.userAgent,
          accept: options.acceptTypes.join(", "),
          "accept-encoding": "gzip, deflate, br",
        },
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          settle({ kind: "redirect", location: response.headers.location, status });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          const reason =
            status === 401 || status === 403 || status === 407 || status === 429
              ? `the site answered ${status}; access controls and rate limits are respected, not worked around`
              : `the site answered ${status}`;
          settle({ kind: "refused", result: refusal("HTTP_STATUS", reason, url.toString(), status) });
          return;
        }

        const { type, charset } = mediaType(response.headers["content-type"]);
        if (!options.acceptTypes.includes(type)) {
          response.resume();
          settle({ kind: "refused", result: refusal("CONTENT_TYPE", `${type || "an unknown type"} is not a document the extractors read`, url.toString(), status) });
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.resume();
          settle({ kind: "refused", result: refusal("TOO_LARGE", `the document is larger than ${options.maxBytes} bytes`, url.toString(), status) });
          return;
        }

        const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
        // The cap is given to zlib as well as counted below. Counting bytes as
        // they arrive stops a bomb, but only *after* the decompressor has
        // already produced the chunk; `maxOutputLength` makes it stop instead,
        // so a single enormously expanding chunk is never allocated.
        const limits = { maxOutputLength: options.maxBytes + 1 };
        let stream: NodeJS.ReadableStream = response;
        if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(zlib.createGunzip(limits));
        else if (encoding === "deflate") stream = response.pipe(zlib.createInflate(limits));
        else if (encoding === "br") stream = response.pipe(zlib.createBrotliDecompress(limits));
        else if (encoding !== "identity") {
          response.resume();
          settle({ kind: "refused", result: refusal("CONTENT_TYPE", `content encoding ${encoding} is not supported`, url.toString(), status) });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            settle({ kind: "refused", result: refusal("TOO_LARGE", `the document is larger than ${options.maxBytes} bytes`, url.toString(), status) });
            request.destroy();
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => settle({ kind: "response", status, contentType: type, charset, body: Buffer.concat(chunks) }));
        stream.on("error", (error: NodeJS.ErrnoException) => {
          // zlib stopping at `maxOutputLength` is a document that was too
          // large, not a network fault, and saying so is what tells an
          // operator the difference between a bomb and a broken connection.
          const tooLarge = error?.code === "ERR_BUFFER_TOO_LARGE";
          settle({
            kind: "refused",
            result: tooLarge
              ? refusal("TOO_LARGE", `the document is larger than ${options.maxBytes} bytes`, url.toString(), status)
              : refusal("NETWORK", "the response could not be read", url.toString(), status),
          });
          request.destroy();
        });
      },
    );

    request.on("error", (error) => {
      const aborted = options.signal.aborted || (error as { name?: string }).name === "AbortError";
      settle({
        kind: "refused",
        result: aborted
          ? refusal("TIMEOUT", "the site took too long to answer", url.toString())
          : refusal("NETWORK", "the site could not be reached", url.toString()),
      });
    });
    request.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const settings = {
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRedirects: options.maxRedirects ?? 3,
    acceptTypes: options.acceptTypes ?? DEFAULT_ACCEPT_TYPES,
    userAgent: options.userAgent ?? KNOWLEDGE_USER_AGENT,
    resolver: options.resolver ?? defaultResolver,
    addressAllowed: options.addressAllowed ?? isPublicAddress,
    allowedPorts: options.allowedPorts ?? [80, 443],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const redirects: string[] = [];
  let current = rawUrl;

  try {
    for (let hop = 0; ; hop++) {
      const checked = await checkDestination(current, settings);
      if ("ok" in checked) return checked;
      if (controller.signal.aborted) return refusal("TIMEOUT", "the site took too long to answer", current);

      const result = await exchange(checked, { ...settings, signal: controller.signal });
      if (result.kind === "refused") return result.result;
      if (result.kind === "response") {
        return {
          ok: true,
          url: checked.url.toString(),
          status: result.status,
          contentType: result.contentType,
          charset: result.charset,
          body: result.body,
          redirects,
        };
      }

      if (hop >= settings.maxRedirects) return refusal("REDIRECT", "too many redirects", current);
      let next: URL;
      try {
        next = new URL(result.location, checked.url);
      } catch {
        return refusal("REDIRECT", "the redirect address is invalid", current);
      }
      if (checked.url.protocol === "https:" && next.protocol === "http:") {
        return refusal("REDIRECT", "a redirect from https to http is refused", current);
      }
      redirects.push(next.toString());
      current = next.toString();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The destination checks alone — scheme, credentials, port, host name, and
 * every resolved address public — without retrieving anything. For callers
 * that must refuse an address before handing it to something else (D-124:
 * the browser renderer starts only from an address this accepts).
 */
export async function vetDestination(rawUrl: string, options: Pick<SafeFetchOptions, "resolver" | "addressAllowed" | "allowedPorts"> = {}): Promise<{ ok: true } | { ok: false; code: SafeFetchRefusal; reason: string }> {
  const checked = await checkDestination(rawUrl, {
    resolver: options.resolver ?? defaultResolver,
    addressAllowed: options.addressAllowed ?? isPublicAddress,
    allowedPorts: options.allowedPorts ?? [80, 443],
  });
  if ("ok" in checked) return checked.ok ? { ok: true } : { ok: false, code: checked.code, reason: checked.reason };
  return { ok: true };
}

/** Decodes a fetched body as text, trusting only charsets TextDecoder knows. */
export function decodeBody(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}
