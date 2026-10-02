import { getLocalServicesConfig } from "@/lib/providers/local/config";
import { buildQuery, preferOfficial } from "./query";
import { searchSearxng, type SearxngResult } from "./searxng";
import { sitemapCandidates, type Fetcher } from "./sitemap";
import type { ProductResearchProvider, ResearchCandidate, ResearchQuery, ResearchResult } from "./types";

/**
 * Free, local source discovery (D-124): `PRODUCT_RESEARCH_PROVIDER=local`.
 *
 * Manifest cannot crawl the internet without an index, so this combines the
 * two free ways it can find a page:
 *
 *  A. The brand's own site. For every domain the Brand Source Registry
 *     approves for the brand (`preferredDomains`), its robots.txt and
 *     sitemaps are read and the addresses that name this product are offered,
 *     best first (`./sitemap`).
 *  B. A SearXNG instance on this computer, when SEARXNG_BASE_URL is set,
 *     asked the same conservative identity query the Brave provider asks
 *     (GTIN, then a strong model number, then brand + exact name + version;
 *     never a vague phrase). Approved official domains are ordered first.
 *
 * Registry URL templates and the pages staff attach are read by the
 * enrichment run itself, whatever the provider (A-6).
 *
 * Either strategy may be missing or down; the other still runs, and what could
 * not be done is returned as notes the run records. Only when neither could
 * run at all is the answer UNAVAILABLE. A result is only ever an address.
 */

const MAX_DOMAINS = 3;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

type SearchCacheEntry = { at: number; result: SearxngResult };
const searchCache = new Map<string, SearchCacheEntry>();

/** Test helper. */
export function clearLocalSearchCache(): void {
  searchCache.clear();
}

export type LocalResearchOptions = {
  searxngBaseUrl: string | null;
  searxngAllowRemote: boolean;
  /** Bearer token for a SearXNG behind a gateway (D-133). */
  searxngToken?: string;
  /** Test seam for sitemap retrieval; production uses `safeFetch`. */
  fetcher?: Fetcher;
};

export class LocalResearchProvider implements ProductResearchProvider {
  readonly key = "local";

  constructor(private readonly options: LocalResearchOptions) {}

  static fromConfig(): LocalResearchProvider {
    const config = getLocalServicesConfig();
    return new LocalResearchProvider({ searxngBaseUrl: config.SEARXNG_BASE_URL ?? null, searxngAllowRemote: config.SEARXNG_ALLOW_REMOTE, searxngToken: config.SEARXNG_AUTH_TOKEN });
  }

  async findSources(query: ResearchQuery): Promise<ResearchResult> {
    const notes: string[] = [];
    const found: ResearchCandidate[] = [];
    let ran = 0;

    // A. The approved official domains' sitemaps.
    const domains = [...new Set(query.preferredDomains.map((domain) => domain.toLowerCase().replace(/^www\./, "")))].slice(0, MAX_DOMAINS);
    if (domains.length === 0) {
      notes.push("No official domain is approved for this brand yet, so no manufacturer sitemap was read.");
    }
    for (const domain of domains) {
      ran += 1;
      const result = await sitemapCandidates(domain, query, { fetcher: this.options.fetcher, limit: Math.min(query.limit, 5) });
      found.push(...result.candidates);
      if (result.note) notes.push(result.note);
    }

    // B. Local web search.
    if (!this.options.searxngBaseUrl) {
      notes.push("Local web search (SearXNG) is not configured; only official-domain sitemaps were searched.");
    } else {
      const search = buildQuery(query);
      if (!search) {
        notes.push("The product's identity is not specific enough to search the web for.");
      } else {
        const result = await this.search(search, query.limit);
        if (result.status === "OK") {
          ran += 1;
          found.push(...result.candidates);
        } else {
          notes.push(`${result.message} Official-domain sitemaps were searched without it.`);
        }
      }
    }

    const seen = new Set<string>();
    const candidates = preferOfficial(
      found.filter((candidate) => {
        const key = candidate.url.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      query.preferredDomains,
    ).slice(0, query.limit);

    if (ran === 0 && candidates.length === 0) {
      return { status: "UNAVAILABLE", message: notes.join(" ") };
    }
    return { status: "OK", candidates, notes };
  }

  /** One search per identity per few minutes: preparation asks before a run, and the run asks again. */
  private async search(search: string, limit: number): Promise<SearxngResult> {
    const key = `${search}\u0000${limit}`;
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.result;
    const result = await searchSearxng(this.options.searxngBaseUrl!, this.options.searxngAllowRemote, search, limit, { token: this.options.searxngToken });
    if (result.status === "OK") {
      searchCache.set(key, { at: Date.now(), result });
      while (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
    }
    return result;
  }
}
