import { localRequest, localServiceUrl } from "@/lib/providers/local/config";
import type { ResearchCandidate } from "./types";

/**
 * Web search through a SearXNG instance running on the owner's computer
 * (D-124). No key: SearXNG is a metasearch engine the owner runs, and Manifest
 * reads its documented JSON output rather than any search engine's result
 * page.
 *
 * Discovery only. A result is an address and a title; the snippet travels as
 * the provider's note so a person can see why a page was offered, and is
 * never read as a product fact. Every address is retrieved and checked later
 * exactly like one staff paste.
 *
 * The base address must be loopback unless the owner explicitly allowed a
 * remote instance. SearXNG answers 403 to `format=json` when JSON output is
 * not enabled in its settings; that is reported as its own state, because the
 * fix (add `json` to `search.formats`) is different from starting the
 * service.
 */

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 2 * 1024 * 1024;

export type SearxngResult =
  | { status: "OK"; candidates: ResearchCandidate[] }
  | { status: "JSON_DISABLED" | "UNAVAILABLE" | "FAILED" | "REFUSED_ADDRESS"; message: string };

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export async function searchSearxng(
  baseUrl: string,
  allowRemote: boolean,
  query: string,
  limit: number,
  options: { timeoutMs?: number } = {},
): Promise<SearxngResult> {
  const base = localServiceUrl(baseUrl, allowRemote);
  if (!base.ok) return { status: "REFUSED_ADDRESS", message: `SEARXNG_BASE_URL is refused: ${base.reason}.` };
  const address = new URL("search", base.url);
  address.searchParams.set("q", query);
  address.searchParams.set("format", "json");
  address.searchParams.set("safesearch", "1");
  address.searchParams.set("categories", "general");

  const response = await localRequest(address, { timeoutMs: options.timeoutMs ?? TIMEOUT_MS, maxBytes: MAX_BYTES });
  if (!response.ok) return { status: "UNAVAILABLE", message: `Local web search (SearXNG): ${response.message}.` };
  if (response.status === 403) {
    return { status: "JSON_DISABLED", message: "Local web search (SearXNG) is running but JSON output is disabled: add json to search.formats in its settings.yml." };
  }
  if (response.status === 429) return { status: "UNAVAILABLE", message: "Local web search (SearXNG) is limiting requests just now." };
  if (response.status !== 200) return { status: "FAILED", message: `Local web search (SearXNG) answered ${response.status}.` };

  let parsed: { results?: { url?: unknown; title?: unknown; content?: unknown }[] };
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { status: "FAILED", message: "Local web search (SearXNG) returned an answer that could not be read." };
  }
  if (!parsed || !Array.isArray(parsed.results)) {
    return { status: "FAILED", message: "Local web search (SearXNG) returned an answer without results." };
  }

  const candidates: ResearchCandidate[] = [];
  const seen = new Set<string>();
  for (const result of parsed.results) {
    const url = usableUrl(result.url);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    candidates.push({
      url,
      title: text(result.title, 200),
      // The search engine's words about the page: why it was offered, never a fact.
      note: text(result.content, 300),
    });
    if (candidates.length >= limit) break;
  }
  return { status: "OK", candidates };
}
