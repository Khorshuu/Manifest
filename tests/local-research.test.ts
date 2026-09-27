/**
 * D-124: free local source discovery — manufacturer sitemaps and a local
 * SearXNG — with the network replaced by fixtures. Nothing leaves the machine.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SafeFetchResult } from "@/lib/pkb/net/safe-fetch";
import { buildQuery } from "@/lib/providers/research/query";
import { clearLocalSearchCache, LocalResearchProvider } from "@/lib/providers/research/local";
import { searchSearxng } from "@/lib/providers/research/searxng";
import {
  clearSitemapCache,
  domainSitemap,
  parseSitemap,
  rankProductUrls,
  SITEMAP_LIMITS,
  sitemapsFromRobots,
  type Fetcher,
} from "@/lib/providers/research/sitemap";
import type { ResearchQuery } from "@/lib/providers/research/types";
import { closedPort } from "./helpers/fake-ollama";

const urlset = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls
    .map((url) => `<url><loc>${url}</loc><image:image><image:loc>${url}.jpg</image:loc></image:image></url>`)
    .join("")}</urlset>`;
const index = (urls: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;

function ok(url: string, body: string | Buffer, contentType = "application/xml"): SafeFetchResult {
  return { ok: true, url, status: 200, contentType, charset: null, body: Buffer.isBuffer(body) ? body : Buffer.from(body), redirects: [] };
}
const missing = (url: string): SafeFetchResult => ({ ok: false, code: "HTTP_STATUS", reason: "not found", status: 404, url });

/** A fake web for sitemap reading, counting what was asked for. */
function web(pages: Record<string, string | Buffer>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const page = pages[url];
    return page === undefined ? missing(url) : ok(url, page, url.endsWith("robots.txt") ? "text/plain" : "application/xml");
  };
  return { fetcher, asked };
}

const base: ResearchQuery = { name: "", brand: null, modelNumbers: [], gtins: [], preferredDomains: [], limit: 5 };

beforeEach(() => {
  clearSitemapCache();
  clearLocalSearchCache();
});

describe("reading sitemaps", () => {
  it("parses a url set and an index, ignoring image locations", () => {
    expect(parseSitemap(urlset(["https://a.test/p/1", "https://a.test/p/2"]))).toEqual({ kind: "urlset", locs: ["https://a.test/p/1", "https://a.test/p/2"] });
    expect(parseSitemap(index(["https://a.test/s1.xml"]))).toEqual({ kind: "index", locs: ["https://a.test/s1.xml"] });
    expect(parseSitemap("<html>not a sitemap</html>").kind).toBe("unknown");
  });

  it("reads the sitemaps robots.txt declares, and only those on the approved domain", () => {
    const robots = "User-agent: *\nDisallow: /cart\nSitemap: https://www.revlon.com/sitemap.xml\nsitemap: https://cdn.elsewhere.test/sitemap.xml # other\n";
    expect(sitemapsFromRobots(robots)).toEqual(["https://www.revlon.com/sitemap.xml", "https://cdn.elsewhere.test/sitemap.xml"]);
  });

  it("follows a sitemap index to its product sitemaps, including a compressed one, and never leaves the domain", async () => {
    const { fetcher, asked } = web({
      "https://brand.test/robots.txt": "User-agent: *\nDisallow: /private\nSitemap: https://brand.test/sitemap_index.xml",
      "https://brand.test/sitemap_index.xml": index([
        "https://brand.test/sitemap_pages_1.xml",
        "https://brand.test/sitemap_products_1.xml.gz",
        "https://brand.test/blog-sitemap.xml",
        "https://evil.test/sitemap.xml",
        "https://brand.test/private/sitemap.xml",
      ]),
      "https://brand.test/sitemap_products_1.xml.gz": gzipSync(urlset(["https://brand.test/products/aurel-hydra-serum-30-ml", "https://brand.test/products/aurel-night-cream"])),
      "https://brand.test/sitemap_pages_1.xml": urlset(["https://brand.test/pages/about", "https://evil.test/products/x"]),
    });
    const sitemap = await domainSitemap("brand.test", { fetcher });
    expect(sitemap.urls).toEqual([
      "https://brand.test/products/aurel-hydra-serum-30-ml",
      "https://brand.test/products/aurel-night-cream",
      "https://brand.test/pages/about",
    ]);
    // Product sitemaps first; the blog, another domain and a disallowed path never asked for.
    expect(asked.indexOf("https://brand.test/sitemap_products_1.xml.gz")).toBeLessThan(asked.indexOf("https://brand.test/sitemap_pages_1.xml"));
    expect(asked).not.toContain("https://brand.test/blog-sitemap.xml");
    expect(asked).not.toContain("https://evil.test/sitemap.xml");
    expect(asked).not.toContain("https://brand.test/private/sitemap.xml");
  });

  it("falls back to the conventional location when robots.txt declares none", async () => {
    const { fetcher, asked } = web({ "https://brand.test/sitemap.xml": urlset(["https://brand.test/products/one"]) });
    expect((await domainSitemap("brand.test", { fetcher })).urls).toEqual(["https://brand.test/products/one"]);
    expect(asked).toEqual(["https://brand.test/robots.txt", "https://brand.test/sitemap.xml", "https://brand.test/sitemap_index.xml"]);
  });

  it("stops at the file, depth and address limits", async () => {
    // An index pointing at itself and at an endless chain of further indexes.
    const pages: Record<string, string> = { "https://brand.test/robots.txt": "Sitemap: https://brand.test/i0.xml" };
    for (let i = 0; i < 100; i++) pages[`https://brand.test/i${i}.xml`] = index([`https://brand.test/i${i}.xml`, `https://brand.test/i${i + 1}.xml`, `https://brand.test/products-${i}.xml`]);
    for (let i = 0; i < 100; i++) pages[`https://brand.test/products-${i}.xml`] = urlset([`https://brand.test/products/item-${i}`]);
    const { fetcher, asked } = web(pages);
    const sitemap = await domainSitemap("brand.test", { fetcher });
    expect(asked.length - 1).toBeLessThanOrEqual(SITEMAP_LIMITS.MAX_FILES);
    // Depth: i0 (0) → i1 (1) → i2 (2) is where the walk stops following indexes.
    expect(asked).not.toContain("https://brand.test/i3.xml");
    expect(sitemap.urls.length).toBeGreaterThan(0);
  });

  it("refuses to read sitemaps when robots.txt cannot be read", async () => {
    const fetcher: Fetcher = async (url) => ({ ok: false, code: "TIMEOUT", reason: "slow", url });
    const sitemap = await domainSitemap("brand.test", { fetcher });
    expect(sitemap.urls).toEqual([]);
    expect(sitemap.note).toMatch(/robots.txt could not be read/);
  });

  it("reads one domain's sitemaps once for many products", async () => {
    const { fetcher, asked } = web({ "https://brand.test/sitemap.xml": urlset(["https://brand.test/products/one"]) });
    await domainSitemap("brand.test", { fetcher });
    const first = asked.length;
    for (let i = 0; i < 20; i++) await domainSitemap("brand.test", { fetcher });
    expect(asked.length).toBe(first);
    // After the cache lifetime it is read again.
    await domainSitemap("brand.test", { fetcher, now: () => Date.now() + SITEMAP_LIMITS.CACHE_TTL_MS + 1 });
    expect(asked.length).toBeGreaterThan(first);
  });
});

describe("ranking sitemap addresses by the product's identity", () => {
  const urls = [
    "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye",
    "https://www.revlon.com/products/colorstay-longwear-makeup",
    "https://www.revlon.com/collections/hair-color",
    "https://www.revlon.com/blogs/news/colorsilk-hair-color-tips",
    "https://www.revlon.com/pages/colorsilk-hair-color-reviews",
    "https://www.sonoline.test/en/wh-4000-wireless-headphones",
    "https://www.sonoline.test/en/wh-4000/reviews",
    "https://shop.test/products/aurel-hydra-serum-30-ml-00812345000012",
  ];

  it("finds a product by brand and exact name, and ignores blogs, reviews and categories", () => {
    const ranked = rankProductUrls(urls, { ...base, name: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", variantValues: ["Black"] }, 5);
    expect(ranked.map((entry) => entry.url)).toEqual(["https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye"]);
  });

  it("finds a product by a strong model number, never by a weak code", () => {
    const byModel = rankProductUrls(urls, { ...base, name: "Sonoline Headphones", brand: "Sonoline", modelNumbers: ["WH-4000"] }, 5);
    expect(byModel[0].url).toBe("https://www.sonoline.test/en/wh-4000-wireless-headphones");
    expect(byModel.map((entry) => entry.url)).not.toContain("https://www.sonoline.test/en/wh-4000/reviews");
    expect(rankProductUrls(urls, { ...base, name: "Shade", brand: "Revlon", modelNumbers: ["10"] }, 5)).toEqual([]);
  });

  it("finds a product by its GTIN, whatever its zero padding", () => {
    const ranked = rankProductUrls(urls, { ...base, name: "Serum", brand: "Aurel", gtins: ["00812345000012"] }, 5);
    expect(ranked[0]).toMatchObject({ url: "https://shop.test/products/aurel-hydra-serum-30-ml-00812345000012", reason: expect.stringContaining("GTIN") });
  });

  it("offers nothing for an unrelated product or a vague name", () => {
    expect(rankProductUrls(urls, { ...base, name: "Glorious Model O Wireless", brand: "Glorious" }, 5)).toEqual([]);
    expect(rankProductUrls(urls, { ...base, name: "Hair Color", brand: "Revlon" }, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------- SearXNG

let searx: http.Server;
let searxUrl = "";
let searxMode: "ok" | "forbidden" | "garbage" = "ok";
const searxQueries: string[] = [];

beforeAll(async () => {
  searx = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    searxQueries.push(url.searchParams.get("q") ?? "");
    if (searxMode === "forbidden") {
      response.writeHead(403, { "content-type": "text/html" });
      return response.end("<h1>403 Forbidden</h1>");
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (searxMode === "garbage") return response.end("<html>");
    response.end(
      JSON.stringify({
        query: url.searchParams.get("q"),
        results: [
          { url: "https://reseller.test/aurel-hydra-serum", title: "Aurel Hydra Serum 30 ml | Reseller", content: "Weight: 999 g. Cheapest price!" },
          { url: "https://www.aurel.test/products/hydra-serum-30ml", title: "Hydra Serum — Aurel", content: "Our serum with hyaluronic acid." },
          { url: "javascript:alert(1)", title: "bad" },
          { url: "https://user:pw@evil.test/x", title: "bad" },
          { url: "https://reseller.test/aurel-hydra-serum", title: "duplicate" },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => searx.listen(0, "127.0.0.1", resolve));
  searxUrl = `http://127.0.0.1:${(searx.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => searx.close(resolve));
});
beforeEach(() => {
  searxMode = "ok";
  searxQueries.length = 0;
});

const serum: ResearchQuery = { ...base, name: "Aurel Hydra Serum 30 ml", brand: "Aurel", preferredDomains: ["aurel.test"] };

describe("local web search through SearXNG", () => {
  it("reads JSON results as addresses, with snippets only as notes", async () => {
    const result = await searchSearxng(searxUrl, false, "Aurel Hydra Serum 30 ml", 10);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.candidates.map((candidate) => candidate.url)).toEqual(["https://reseller.test/aurel-hydra-serum", "https://www.aurel.test/products/hydra-serum-30ml"]);
    // The snippet is carried as the provider's note, never as a field that could become a fact.
    expect(result.candidates[0]).toEqual({ url: "https://reseller.test/aurel-hydra-serum", title: "Aurel Hydra Serum 30 ml | Reseller", note: "Weight: 999 g. Cheapest price!" });
  });

  it("says when JSON output is disabled, and when the answer is not JSON", async () => {
    searxMode = "forbidden";
    expect(await searchSearxng(searxUrl, false, "x", 5)).toMatchObject({ status: "JSON_DISABLED" });
    searxMode = "garbage";
    expect(await searchSearxng(searxUrl, false, "x", 5)).toMatchObject({ status: "FAILED" });
  });

  it("refuses a remote SearXNG unless explicitly allowed", async () => {
    expect(await searchSearxng("https://searx.example.org", false, "x", 5)).toMatchObject({ status: "REFUSED_ADDRESS" });
  });
});

describe("the local research provider", () => {
  it("combines the official sitemap and local search, official domains first", async () => {
    const { fetcher } = web({ "https://aurel.test/sitemap.xml": urlset(["https://aurel.test/products/aurel-hydra-serum-30-ml", "https://aurel.test/products/night-cream"]) });
    const provider = new LocalResearchProvider({ searxngBaseUrl: searxUrl, searxngAllowRemote: false, fetcher });
    const result = await provider.findSources(serum);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    const hosts = result.candidates.map((candidate) => new URL(candidate.url).hostname);
    expect(hosts.slice(0, 2)).toEqual(["aurel.test", "www.aurel.test"]);
    expect(hosts).toContain("reseller.test");
    expect(result.candidates[0].note).toMatch(/sitemap/);
    // The conservative identity query, not a category phrase.
    expect(searxQueries).toEqual(["Aurel Hydra Serum 30 ml"]);
  });

  it("asks the GTIN first, then a strong model number", () => {
    expect(buildQuery({ ...serum, gtins: ["00812345000012"], modelNumbers: ["AHS-30"] })).toBe("Aurel 00812345000012");
    expect(buildQuery({ ...serum, modelNumbers: ["AHS-30"] })).toBe("Aurel AHS-30");
    expect(buildQuery({ ...base, name: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", variantValues: ["Black"] })).toBe("Revlon Colorsilk Hair Color Black");
  });

  it("does not search a vague product at all", async () => {
    const provider = new LocalResearchProvider({ searxngBaseUrl: searxUrl, searxngAllowRemote: false, fetcher: web({}).fetcher });
    const result = await provider.findSources({ ...base, name: "Hair Color", brand: "Revlon", preferredDomains: ["revlon.test"] });
    expect(searxQueries).toEqual([]);
    expect(result).toMatchObject({ status: "OK", candidates: [], notes: expect.arrayContaining([expect.stringMatching(/not specific enough/)]) });
  });

  it("carries on with sitemaps when SearXNG is not running, and says so", async () => {
    const { fetcher } = web({ "https://aurel.test/sitemap.xml": urlset(["https://aurel.test/products/aurel-hydra-serum-30-ml"]) });
    const provider = new LocalResearchProvider({ searxngBaseUrl: `http://127.0.0.1:${await closedPort()}`, searxngAllowRemote: false, fetcher });
    const result = await provider.findSources(serum);
    expect(result).toMatchObject({
      status: "OK",
      candidates: [{ url: "https://aurel.test/products/aurel-hydra-serum-30-ml" }],
      notes: expect.arrayContaining([expect.stringMatching(/SearXNG.*not running.*Official-domain sitemaps were searched without it/)]),
    });
  });

  it("is unavailable only when neither strategy could run", async () => {
    const provider = new LocalResearchProvider({ searxngBaseUrl: null, searxngAllowRemote: false });
    const result = await provider.findSources({ ...serum, preferredDomains: [] });
    expect(result).toMatchObject({ status: "UNAVAILABLE", message: expect.stringMatching(/No official domain is approved.*SearXNG\) is not configured/) });
  });

  it("searches once for the same identity within a few minutes", async () => {
    const provider = new LocalResearchProvider({ searxngBaseUrl: searxUrl, searxngAllowRemote: false, fetcher: web({}).fetcher });
    await provider.findSources(serum);
    await provider.findSources(serum);
    expect(searxQueries).toHaveLength(1);
  });
});
