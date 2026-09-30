import { urlLanguagePreference } from "@/lib/pkb/language";
import { gunzipSync } from "node:zlib";
import { Parser } from "htmlparser2";
import { isStrongModelKey } from "@/lib/pkb/identity-labels";
import { robotsAllows } from "@/lib/pkb/net/robots";
import { decodeBody, safeFetch, type SafeFetchResult } from "@/lib/pkb/net/safe-fetch";
import { identityWords, onDomain } from "./query";
import type { ResearchCandidate, ResearchQuery } from "./types";

/**
 * Finding a product's page in its manufacturer's own sitemap (D-124).
 *
 * When the Brand Source Registry already approves a domain as the brand's
 * official site, the site itself says which pages exist: robots.txt declares
 * its sitemaps, and a sitemap lists its product pages. Reading them costs
 * nothing, needs no search service, and never leaves the brand's own domain.
 *
 * This is discovery only. A sitemap line is an address, never evidence: every
 * address offered here is retrieved later through `safeFetch`, allowed by
 * robots.txt, matched against the product's identity by `identityVerdict`,
 * read, grounded and reviewed exactly like an address staff paste.
 *
 * Bounded everywhere: robots.txt is read first and obeyed for the sitemap
 * files themselves; only sitemaps on the approved domain are read; an index is
 * followed at most `MAX_DEPTH` levels and `MAX_FILES` files, product-looking
 * child sitemaps first; each file is size- and time-capped (compressed ones
 * are decompressed with the same cap); and at most `MAX_URLS` addresses are
 * kept per domain. The result is cached per domain, so a hundred products of
 * one brand read its sitemaps once, not a hundred times.
 */

export const SITEMAP_LIMITS = {
  MAX_DEPTH: 3,
  MAX_FILES: 25,
  MAX_URLS: 50_000,
  MAX_BYTES: 10 * 1024 * 1024,
  FILE_TIMEOUT_MS: 15_000,
  /** The whole walk of one domain. */
  BUDGET_MS: 60_000,
  CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  /** A domain with no readable sitemap is asked again after this long. */
  NEGATIVE_TTL_MS: 60 * 60 * 1000,
  CACHE_DOMAINS: 20,
};

const SITEMAP_TYPES = [
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "text/plain",
];

export type Fetcher = (url: string, options: { maxBytes: number; timeoutMs: number; acceptTypes: string[] }) => Promise<SafeFetchResult>;

const defaultFetcher: Fetcher = (url, options) => safeFetch(url, options);

// ------------------------------------------------------------------ parsing

export type ParsedSitemap = { kind: "urlset" | "index" | "unknown"; locs: string[] };

/** The addresses in one sitemap file (`<urlset>` or `<sitemapindex>`), in order. */
export function parseSitemap(xml: string, max = SITEMAP_LIMITS.MAX_URLS): ParsedSitemap {
  let kind: ParsedSitemap["kind"] = "unknown";
  const locs: string[] = [];
  let inLoc = false;
  let current = "";
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase().replace(/^[\w-]+:/, "");
        if (kind === "unknown" && tag === "urlset") kind = "urlset";
        if (kind === "unknown" && tag === "sitemapindex") kind = "index";
        // Only the page's own <loc>, not <image:loc> or <video:loc>.
        if (name.toLowerCase() === "loc") {
          inLoc = true;
          current = "";
        }
      },
      ontext(text) {
        if (inLoc) current += text;
      },
      onclosetag(name) {
        if (name.toLowerCase() === "loc" && inLoc) {
          inLoc = false;
          const value = current.trim();
          if (value && locs.length < max) locs.push(value);
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  return { kind, locs };
}

/** `Sitemap:` lines of a robots.txt file. */
export function sitemapsFromRobots(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line.replace(/#.*$/, ""));
    if (match) found.push(match[1]);
  }
  return [...new Set(found)].slice(0, 50);
}

/** An http(s) address on the approved domain, or nothing. */
function onApprovedDomain(raw: string, domain: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (!onDomain(url.hostname, domain)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Child sitemaps that look like product listings first, obviously-not-product ones never. */
function childPriority(url: string): number {
  // "sitemap" itself contains "item"; judge the rest of the address.
  const path = url.toLowerCase().replace(/sitemaps?/g, "");
  if (/(blog|post|article|news|author|tag|video|image|press|store-?locat|locations?|faq|help-?center)[^/]*\.xml/.test(path)) return -1;
  if (/product|item|catalog|shop|sku|goods/.test(path)) return 0;
  if (/categor|collection|page|brand/.test(path)) return 2;
  return 1;
}

// ------------------------------------------------------------------ walking

export type DomainSitemap = {
  urls: string[];
  /** What happened, for the run's notes. */
  note: string | null;
  filesRead: number;
};

type CacheEntry = { at: number; value: DomainSitemap };
const cache = new Map<string, CacheEntry>();

/** Test helper. */
export function clearSitemapCache(): void {
  cache.clear();
}

function decodeSitemap(result: Extract<SafeFetchResult, { ok: true }>, maxBytes: number): string | null {
  const gz = result.body.length >= 2 && result.body[0] === 0x1f && result.body[1] === 0x8b;
  if (!gz) return decodeBody(result.body, result.charset);
  try {
    return gunzipSync(result.body, { maxOutputLength: maxBytes }).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Every page address a domain's sitemaps list, read at most once per cache
 * period. Failures are quiet and typed as a note: a domain without a sitemap
 * is ordinary, and the run carries on with its other sources.
 */
export async function domainSitemap(
  domain: string,
  options: { fetcher?: Fetcher; now?: () => number } = {},
): Promise<DomainSitemap> {
  const now = options.now ?? Date.now;
  const key = domain.toLowerCase().replace(/^www\./, "");
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.value.urls.length > 0 ? SITEMAP_LIMITS.CACHE_TTL_MS : SITEMAP_LIMITS.NEGATIVE_TTL_MS;
    if (now() - cached.at < ttl) return cached.value;
    cache.delete(key);
  }
  const value = await walk(key, options.fetcher ?? defaultFetcher, now);
  cache.set(key, { at: now(), value });
  while (cache.size > SITEMAP_LIMITS.CACHE_DOMAINS) cache.delete(cache.keys().next().value!);
  return value;
}

async function walk(domain: string, fetcher: Fetcher, now: () => number): Promise<DomainSitemap> {
  const started = now();
  const origin = `https://${domain}`;
  const robots = await fetcher(`${origin}/robots.txt`, {
    maxBytes: 512 * 1024,
    timeoutMs: 8_000,
    acceptTypes: ["text/plain", "text/html", "application/octet-stream"],
  });
  let robotsText: string | null = null;
  if (robots.ok) robotsText = decodeBody(robots.body, robots.charset);
  else if (!(robots.code === "HTTP_STATUS" && robots.status !== undefined && robots.status >= 400 && robots.status < 500)) {
    // Not being able to ask is not permission (RFC 9309), as for pages.
    return { urls: [], note: `${domain}: robots.txt could not be read, so its sitemaps were not.`, filesRead: 0 };
  }
  const allowed = (url: string) => {
    if (robotsText === null) return true;
    const parsed = new URL(url);
    return robotsAllows(robotsText, `${parsed.pathname}${parsed.search}`);
  };

  const declared = robotsText ? sitemapsFromRobots(robotsText).map((url) => onApprovedDomain(url, domain)).filter((url): url is string => url !== null) : [];
  const roots = declared.length > 0 ? declared : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  const queue: { url: string; depth: number }[] = roots.map((url) => ({ url, depth: 0 }));
  const visited = new Set<string>();
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  let filesRead = 0;
  let stopped: string | null = null;

  while (queue.length > 0) {
    if (filesRead >= SITEMAP_LIMITS.MAX_FILES) {
      stopped = `stopped after ${SITEMAP_LIMITS.MAX_FILES} sitemap files`;
      break;
    }
    if (urls.length >= SITEMAP_LIMITS.MAX_URLS) {
      stopped = `stopped at ${SITEMAP_LIMITS.MAX_URLS} addresses`;
      break;
    }
    if (now() - started > SITEMAP_LIMITS.BUDGET_MS) {
      stopped = "stopped at the time limit";
      break;
    }
    const next = queue.shift()!;
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    if (!allowed(next.url)) continue;

    const result = await fetcher(next.url, {
      maxBytes: SITEMAP_LIMITS.MAX_BYTES,
      timeoutMs: SITEMAP_LIMITS.FILE_TIMEOUT_MS,
      acceptTypes: SITEMAP_TYPES,
    });
    if (!result.ok) continue;
    // A redirect that left the approved domain is not the brand's sitemap.
    if (!onApprovedDomain(result.url, domain)) continue;
    filesRead += 1;
    const xml = decodeSitemap(result, SITEMAP_LIMITS.MAX_BYTES);
    if (!xml) continue;
    const parsed = parseSitemap(xml, SITEMAP_LIMITS.MAX_URLS - urls.length);

    if (parsed.kind === "index") {
      if (next.depth + 1 >= SITEMAP_LIMITS.MAX_DEPTH) continue;
      const children = parsed.locs
        .map((loc) => onApprovedDomain(loc, domain))
        .filter((url): url is string => url !== null && childPriority(url) >= 0)
        .sort((a, b) => childPriority(a) - childPriority(b));
      // Product-looking children go before whatever was already waiting.
      const product = children.filter((url) => childPriority(url) === 0).map((url) => ({ url, depth: next.depth + 1 }));
      const other = children.filter((url) => childPriority(url) > 0).map((url) => ({ url, depth: next.depth + 1 }));
      queue.unshift(...product);
      queue.push(...other);
      continue;
    }
    if (parsed.kind === "urlset") {
      for (const loc of parsed.locs) {
        const url = onApprovedDomain(loc, domain);
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        urls.push(url);
      }
    }
  }

  const note =
    urls.length === 0
      ? filesRead === 0
        ? `${domain}: no readable sitemap.`
        : `${domain}: its sitemaps list no pages.`
      : stopped
        ? `${domain}: sitemap reading ${stopped}.`
        : null;
  return { urls, note, filesRead };
}

// ------------------------------------------------------------------ ranking

/** Path segments of pages that are never one product's page. */
const EXCLUDED_SEGMENTS = new Set([
  "blog", "blogs", "news", "article", "articles", "stories", "story", "press",
  "review", "reviews", "ratings", "questions",
  "category", "categories", "collections", "collection", "c", "tag", "tags", "author", "authors",
  "account", "cart", "basket", "checkout", "login", "signin", "register", "wishlist",
  "search", "compare", "promo", "promotions", "offers", "sale", "deals", "gift-cards", "giftcards",
  "careers", "jobs", "legal", "privacy", "terms", "contact", "about", "about-us", "store-locator", "stores",
]);
/** Words in an address that mark a page about many products, or about opinions of one. */
const EXCLUDED_WORDS = new Set(["blog", "blogs", "news", "article", "articles", "review", "reviews", "ratings", "category", "categories", "collection", "collections", "promo", "promotions", "sale", "deals", "compare", "careers"]);
/** Segments that mark a product page even under an excluded one ("/collections/x/products/y"). */
const PRODUCT_SEGMENTS = new Set(["product", "products", "p", "item", "items", "dp", "shop", "sku"]);

function pathTokens(url: URL): { segments: string[]; tokens: string[] } {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  const segments = path.toLowerCase().split("/").filter(Boolean);
  const tokens = `${segments.join(" ")} ${url.search.toLowerCase()}`
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return { segments, tokens };
}

const singular = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export type RankedUrl = { url: string; score: number; reason: string };

/**
 * The sitemap addresses that name this product, best first.
 *
 * An address qualifies by the product's strongest identity, exactly as a
 * search query is built (D-114, D-123): a GTIN in the address; a manufacturer
 * model or part number that can identify a product (never "10" or "(1N)");
 * or most of the words of the exact name besides the brand — at least two of
 * them, and at least three quarters of a name of four or more words. Pages
 * that are never one product's page — blogs, reviews, categories, carts,
 * accounts, promotions — are not offered at all. The version is a tie-breaker
 * only: many shops sell every shade from one address.
 */
export function rankProductUrls(urls: string[], query: ResearchQuery, limit: number): RankedUrl[] {
  const brandWords = new Set((query.brand ? identityWords(query.brand) : []).map(singular));
  let name = query.name.trim();
  if (query.brand && name.toLowerCase().startsWith(`${query.brand.toLowerCase()} `)) name = name.slice(query.brand.length).trim();
  const nameWords = [...new Set(identityWords(name).map(singular).filter((word) => !brandWords.has(word)))];
  const variantWords = [...new Set((query.variantValues ?? []).flatMap((value) => identityWords(value).map(singular)))].filter(
    (word) => !nameWords.includes(word),
  );
  const gtins = query.gtins.map((gtin) => gtin.replace(/\D/g, "").replace(/^0+/, "")).filter((gtin) => gtin.length >= 8);
  const models = query.modelNumbers.filter((value) => isStrongModelKey(value)).map(compact).filter((value) => value.length >= 4);
  // As vague as a search would be is too vague to match (D-123): three words, or two and a version.
  const nameSpecific = nameWords.length >= 3 || (nameWords.length >= 2 && (query.variantValues ?? []).length > 0);
  const needed = nameWords.length >= 4 ? Math.ceil(nameWords.length * 0.75) : Math.min(nameWords.length, Math.max(2, nameWords.length));

  const ranked: RankedUrl[] = [];
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const { segments, tokens } = pathTokens(url);
    if (segments.length === 0) continue;
    const productSegment = segments.some((segment) => PRODUCT_SEGMENTS.has(segment));
    if (!productSegment && segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    // A product page may sit under /collections/, but "…-reviews" is still not the product.
    const lastWords = (segments.at(-1) ?? "").split(/[^\p{L}\p{N}]+/u);
    if (lastWords.some((word) => EXCLUDED_WORDS.has(word))) continue;

    const words = new Set(tokens.map(singular));
    const digits = tokens.filter((token) => /^\d{8,14}$/.test(token)).map((token) => token.replace(/^0+/, ""));
    const joined = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      let run = "";
      for (let j = i; j < Math.min(tokens.length, i + 4); j++) {
        run += tokens[j];
        joined.add(run);
      }
    }

    let score = 0;
    const reasons: string[] = [];
    if (gtins.some((gtin) => digits.includes(gtin))) {
      score += 100;
      reasons.push("its GTIN");
    }
    if (models.some((model) => joined.has(model))) {
      score += 80;
      reasons.push("its model number");
    }
    const matched = nameWords.filter((word) => words.has(word)).length;
    if (nameSpecific && matched >= needed && matched >= 2) {
      score += Math.round((matched / nameWords.length) * 60);
      reasons.push(`${matched} of ${nameWords.length} words of its name`);
    }
    if (score === 0) continue;
    if (variantWords.length > 0 && variantWords.every((word) => words.has(word))) {
      score += 10;
      reasons.push("its version");
    }
    if (productSegment) score += 5;
    // Several locales of one page often share a sitemap; the English one is
    // preferred and another language's comes last (D-128). A hint only: the
    // page's language is checked when it is read.
    const language = urlLanguagePreference(url.toString());
    if (language !== 0) {
      score += language * 8;
      if (language > 0) reasons.push("English locale");
    }
    ranked.push({ url: url.toString(), score, reason: reasons.join(", ") });
  }
  return ranked.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, limit);
}

/** Candidates from one approved domain's sitemaps. */
export async function sitemapCandidates(
  domain: string,
  query: ResearchQuery,
  options: { fetcher?: Fetcher; limit?: number } = {},
): Promise<{ candidates: ResearchCandidate[]; note: string | null }> {
  const sitemap = await domainSitemap(domain, { fetcher: options.fetcher });
  const ranked = rankProductUrls(sitemap.urls, query, options.limit ?? 5);
  return {
    candidates: ranked.map((entry) => ({
      url: entry.url,
      title: null,
      // Why it was offered. Not a fact about the product.
      note: `Listed in ${domain}'s sitemap; the address names ${entry.reason}.`,
    })),
    note: sitemap.note,
  };
}
