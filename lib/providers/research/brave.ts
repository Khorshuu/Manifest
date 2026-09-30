import { buildQuery, preferOfficial } from "./query";
import type { ProductResearchProvider, ResearchCandidate, ResearchQuery, ResearchResult } from "./types";

/**
 * Automatic source discovery through the Brave Search API (D-114).
 *
 * The provider answers exactly one question — *which addresses might describe
 * this product?* — and nothing else. It returns addresses and the titles the
 * index holds for them. It never returns a specification, a measurement or a
 * price, and a snippet is not passed on as a fact: everything the pipeline
 * later believes still has to be retrieved through `safeFetch`, allowed by
 * robots.txt, matched against the product's own identifiers and proposed as a
 * claim for a person to accept (D-074, invariant I-1).
 *
 * Why an API and not a search page: parsing a search engine's HTML breaks
 * without warning and is usually against the service's terms. This is a
 * documented JSON endpoint with a stable shape, on one pinned host, with a key
 * the shop holds. Nothing here is required — `PRODUCT_RESEARCH_PROVIDER=none`
 * stays the default and the whole pipeline works without it (A-6).
 *
 * The request is deliberately narrow. The query is built from the product's
 * *identifiers*, not from its marketing name, because a model number or a GTIN
 * either matches a page or does not, where a name matches a thousand pages
 * about something else. A product with no identifier is not searched for at
 * all: that is the same product the resolution gate has already stopped.
 *
 * Failure is typed and quiet. A missing key is UNAVAILABLE, a quota or an
 * outage is UNAVAILABLE, an unreadable answer is FAILED, and in every one of
 * those the run continues on the registry, the staff URLs and the documents it
 * already has. No provider answer can write anything.
 */

/** Pinned: the host is never taken from configuration or from a response. */
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 8_000;
/** The answer is small; a large one means something other than the API replied. */
const MAX_BYTES = 512 * 1024;

type BraveResponse = {
  web?: { results?: { url?: unknown; title?: unknown; description?: unknown }[] };
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/<[^>]*>/g, "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** An https address on a public-looking host, or nothing. The pipeline checks it again. */
function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export { buildQuery, preferOfficial };

export class BraveResearchProvider implements ProductResearchProvider {
  readonly key = "brave";

  constructor(private readonly apiKey: string | undefined) {}

  async findSources(query: ResearchQuery): Promise<ResearchResult> {
    if (!this.apiKey) {
      return {
        status: "UNAVAILABLE",
        message: "BRAVE_SEARCH_API_KEY is not set, so automatic source discovery cannot run.",
      };
    }

    const search = buildQuery(query);
    if (!search) {
      return {
        status: "OK",
        candidates: [],
      };
    }

    const address = new URL(ENDPOINT);
    address.searchParams.set("q", search);
    address.searchParams.set("count", String(Math.min(Math.max(query.limit, 1), 20)));
    address.searchParams.set("safesearch", "strict");
    address.searchParams.set("result_filter", "web");
    // English pages only are read (D-128).
    address.searchParams.set("search_lang", "en");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(address, {
        method: "GET",
        signal: controller.signal,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": this.apiKey,
        },
      });
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        message: error instanceof Error && error.name === "AbortError" ? "The search service did not answer in time." : "The search service could not be reached.",
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      return { status: "UNAVAILABLE", message: "The search service's quota for this period is spent." };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "UNAVAILABLE", message: "The search service refused the configured credential." };
    }
    if (!response.ok) {
      return { status: "FAILED", message: `The search service answered ${response.status}.` };
    }

    const body = await response.text();
    if (body.length > MAX_BYTES) {
      return { status: "FAILED", message: "The search service's answer was larger than expected." };
    }

    let parsed: BraveResponse;
    try {
      parsed = JSON.parse(body) as BraveResponse;
    } catch {
      return { status: "FAILED", message: "The search service's answer could not be read." };
    }

    const candidates: ResearchCandidate[] = [];
    const seen = new Set<string>();
    for (const result of parsed.web?.results ?? []) {
      const url = usableUrl(result.url);
      if (!url || seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      candidates.push({
        url,
        title: text(result.title, 200),
        // The index's own words about the page, kept as the provider's note so
        // a person can see why it was offered. Never treated as a product fact.
        note: text(result.description, 300),
      });
      if (candidates.length >= query.limit) break;
    }

    return { status: "OK", candidates: preferOfficial(candidates, query.preferredDomains) };
  }
}
