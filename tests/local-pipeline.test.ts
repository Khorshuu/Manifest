/**
 * D-124, stored: the free local engine end to end against a real database —
 * local discovery (an official sitemap and a local SearXNG), static fetch
 * first, the browser renderer only for a JavaScript shell, related official
 * pages, Ollama reading prose, grounding, and Ollama writing SeoPulse content
 * through Product Preparation — with no paid key set.
 *
 * The network is replaced by fixture pages; Ollama and SearXNG by fakes on
 * loopback ports. Four kinds of product, none special-cased in the code: a
 * hair colour sold by shade, headphones with a specification page, a skincare
 * cream, and a serum whose page is rendered by JavaScript.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pkbAttributeProposals,
  pkbClaims,
  pkbEnrichmentRuns,
  pkbEvidence,
  pkbProducts,
  pkbSourceDocuments,
  productPreparationRuns,
  products,
  seoResearchRuns,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { requestEnrichment, runEnrichment } from "@/lib/pkb/enrichment";
import type { PageRenderer } from "@/lib/pkb/net/render";
import { setPageRendererForTesting } from "@/lib/pkb/net/render";
import { decideRegistryEntry, suggestRegistryEntry, trustedBrandIds } from "@/lib/pkb/trust";
import { advancePreparation, startPreparation } from "@/lib/preparation";
import { OllamaExtractionProvider, setProductExtractionProviderForTesting } from "@/lib/providers/extraction";
import { OllamaClient } from "@/lib/providers/local/ollama";
import { LocalResearchProvider, setProductResearchProviderForTesting } from "@/lib/providers/research";
import { clearLocalSearchCache } from "@/lib/providers/research/local";
import { clearSitemapCache, type Fetcher } from "@/lib/providers/research/sitemap";
import { processSearchQueue } from "@/lib/search/maintenance";
import { contentOwnership, setFieldLock } from "@/lib/seo/fields";
import { OllamaIntelligenceProvider } from "@/lib/seo-pulse/providers/ollama";
import { seoPulseRecommendations } from "@/lib/seo-pulse/service";
import { AnthropicIntelligenceProvider, RulesIntelligenceProvider, setIntelligenceProviderForTesting } from "@/lib/seo-pulse/providers/intelligence";
import { sanitizeGenerated } from "@/lib/seo-pulse/sanitize";
import { closedPort, startFakeOllama, type FakeOllama } from "./helpers/fake-ollama";
import { createTestDatabase } from "./helpers/database";

// ------------------------------------------------------------------ the web

const REVLON = "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451";
const SONOLINE = "https://www.sonoline.test/en/wh-4000-wireless-headphones";
const SONOLINE_SPECS = "https://www.sonoline.test/en/support/wh-4000/specifications";
const NORTHFIELD = "https://www.northfield.test/products/daily-barrier-cream";
const AUREL = "https://www.aurel.test/products/hydra-serum-30-ml";

const SONOLINE_PAGE = `<!doctype html><html><head><title>Sonoline WH-4000 Wireless Headphones</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Sonoline WH-4000 Wireless Headphones","brand":{"@type":"Brand","name":"Sonoline"},"mpn":"WH-4000","model":"WH-4000"}</script></head>
<body><nav><a href="/en/support">Support</a><a href="/en/collections/headphones">All headphones</a></nav>
<h1>Sonoline WH-4000 Wireless Headphones</h1>
<table><tr><th>Driver</th><td>40 mm</td></tr><tr><th>Bluetooth</th><td>5.3</td></tr></table>
<a href="/en/support/wh-4000/specifications">Technical specifications</a>
<a href="/en/wh-4000/reviews">Read reviews of the WH-4000</a>
<a href="/en/blog/wh-4000-launch">WH-4000 launch story</a>
</body></html>`;

const SONOLINE_SPECS_PAGE = `<!doctype html><html><head><title>WH-4000 specifications | Sonoline</title></head>
<body><h1>Sonoline WH-4000 Wireless Headphones — Specifications</h1>
<dl><dt>Model number</dt><dd>WH-4000</dd><dt>Battery life</dt><dd>30 hours</dd><dt>Charging port</dt><dd>USB-C</dd><dt>Weight</dt><dd>250 g</dd></dl>
<a href="/en/support/wh-4000/manual">Manual</a></body></html>`;

/** A JavaScript shell: nothing to read until a browser runs it. */
const AUREL_SHELL = `<!doctype html><html><head><title>Aurel</title><script src="/assets/app.js"></script></head><body><div id="root"></div><noscript>Please enable JavaScript to view this page.</noscript></body></html>`;
const AUREL_RENDERED = `<!doctype html><html><head><title>Aurel Hydra Serum 30 ml</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Aurel Hydra Serum 30 ml","brand":{"@type":"Brand","name":"Aurel"}}</script></head>
<body><div id="root"><h1>Aurel Hydra Serum 30 ml</h1><table><tr><th>Volume</th><td>30 ml</td></tr><tr><th>Skin type</th><td>All skin types</td></tr><tr><th>Key ingredient</th><td>Hyaluronic acid</td></tr></table></div></body></html>`;

const PAGES: Record<string, string> = {
  [REVLON]: readFileSync("tests/fixtures/revlon-colorsilk.html", "utf8"),
  [SONOLINE]: SONOLINE_PAGE,
  [SONOLINE_SPECS]: SONOLINE_SPECS_PAGE,
  [NORTHFIELD]: readFileSync("tests/fixtures/northfield-barrier-cream.html", "utf8"),
  [AUREL]: AUREL_SHELL,
};
const fetched: string[] = [];

vi.mock("@/lib/pkb/net/robots", async (original) => ({
  ...(await original<typeof import("@/lib/pkb/net/robots")>()),
  checkRobots: async () => ({ allowed: true, reason: "allowed" }),
}));
vi.mock("@/lib/pkb/net/safe-fetch", async (original) => {
  const actual = await original<typeof import("@/lib/pkb/net/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string) => {
      fetched.push(url);
      return PAGES[url]
        ? { ok: true, url, status: 200, contentType: "text/html", charset: "utf-8", body: Buffer.from(PAGES[url]), redirects: [] }
        : { ok: false, code: "HTTP_STATUS", reason: "not found", status: 404, url };
    },
  };
});

/** Sitemaps of the official domains, for the local provider's sitemap reader. */
const SITEMAPS: Record<string, string> = {
  "https://northfield.test/robots.txt": "User-agent: *\nSitemap: https://www.northfield.test/sitemap.xml",
  "https://www.northfield.test/sitemap.xml": `<urlset><url><loc>${NORTHFIELD}</loc></url><url><loc>https://www.northfield.test/products/night-balm</loc></url><url><loc>https://www.northfield.test/blogs/news/barrier-cream-tips</loc></url></urlset>`,
};
const sitemapFetcher: Fetcher = async (url) =>
  SITEMAPS[url]
    ? { ok: true, url, status: 200, contentType: url.endsWith(".txt") ? "text/plain" : "application/xml", charset: null, body: Buffer.from(SITEMAPS[url]), redirects: [] }
    : { ok: false, code: "HTTP_STATUS", reason: "not found", status: 404, url };

// ------------------------------------------------------- local services

let ollama: FakeOllama;
let searx: http.Server;
let searxUrl = "";

/** What a local model might say about the Revlon page: true statements, and three it made up. */
const REVLON_ANSWER = {
  candidates: [
    { label: "Gray coverage", value: "100%", unit: null, excerpt: "Ammonia-free** color delivers 100% gray coverage", section: "DETAILS", meaning: "grey coverage", kind: "product_fact" },
    { label: "Processing time", value: "25 minutes", unit: null, excerpt: "Leave it on for 25 minutes total.", section: "HOW TO USE IT", meaning: null, kind: "compatibility_use" },
    { label: "Color duration", value: "up to 12 weeks", unit: null, excerpt: "up to 8 weeks of vibrant, salon-quality color and shine", section: null, meaning: null, kind: "product_fact" },
    { label: "Certification", value: "Dermatologist tested", unit: null, excerpt: "Dermatologist tested for sensitive scalps.", section: null, meaning: null, kind: "product_fact" },
    { label: "Lift", value: "up to 3 levels", unit: null, excerpt: "Light Ash Blonde (08) lifts up to 3 levels.", section: null, meaning: null, kind: "variant_fact" },
  ],
};

const keyword = (value: string) => ({ keyword: value, intent: "product", relevance: "high", reason: "names the product" });
const SEO_ANSWER_DEFAULT = {
  primaryKeyword: keyword("harbor acoustics hp-900 headphones"),
  secondaryKeywords: [keyword("hp-900 bluetooth headphones")],
  longTailKeywords: [],
  synonyms: [],
  relatedTerms: ["noise cancelling headphones"],
  searchAliases: ["hp900 headphones"],
  misspellings: [],
  searchPhrases: ["harbor acoustics hp-900"],
  brandVariations: [],
  seoTitle: { recommended: "Harbor Acoustics HP-900 Headphones", alternatives: [], reason: "names it" },
  metaDescription: { recommended: "Harbor Acoustics HP-900 headphones with 40 mm drivers, Bluetooth 5.4 and active noise cancelling.", reason: "established facts" },
  h1: { recommended: "Harbor Acoustics HP-900 Headphones", reason: "plain" },
  slug: { recommended: "harbor-acoustics-hp-900-headphones", reason: "clean" },
  description: { improvements: [], suggestedHtml: "<p>LOCAL-MODEL: The Harbor Acoustics HP-900 headphones pair 40 mm drivers with Bluetooth 5.4 and active noise cancelling.</p>" },
  tags: ["headphones", "noise cancelling"],
  keyFeatures: ["40 mm drivers", "Bluetooth 5.4 connectivity", "Active noise cancelling", "30-hour battery"],
  imageAlts: [],
  faqs: [],
  categoryNotes: [],
};

/** What the local model answers SeoPulse with; a test may change it. */
let seoAnswer: typeof SEO_ANSWER_DEFAULT = structuredClone(SEO_ANSWER_DEFAULT);
/** Replaces the answer with raw text, for a model that answers badly. */
let seoRaw: string | null = null;
const seoReply = () => ({ content: seoRaw ?? JSON.stringify(seoAnswer) });

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/unused";
  // No paid service is configured for any of this.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  harness = await createTestDatabase();
  ollama = await startFakeOllama({
    models: ["qwen2.5:7b"],
    chat: (request) =>
      JSON.stringify(request.format).includes('"candidates"')
        ? { content: JSON.stringify(REVLON_ANSWER) }
        : seoReply(),
  });
  searx = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    // Answers for the one product it knows; anything else finds nothing.
    if (!new URL(request.url ?? "/", "http://x").searchParams.get("q")?.includes("Northfield")) return response.end(JSON.stringify({ results: [] }));
    response.end(
      JSON.stringify({
        results: [
          // A reseller whose snippet states a figure; its page is not reachable.
          { url: "https://reseller.test/northfield-daily-barrier-cream", title: "Northfield Botanics Daily Barrier Cream", content: "Net weight 999 g. Best price!" },
          { url: NORTHFIELD, title: "Daily Barrier Cream | Northfield Botanics", content: "Ceramides." },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => searx.listen(0, "127.0.0.1", resolve));
  searxUrl = `http://127.0.0.1:${(searx.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await ollama.close();
  await new Promise((resolve) => searx.close(resolve));
  await harness.close();
});

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let seq = 0;

/** Records every render request; renders only the Aurel shell. */
class FixtureRenderer implements PageRenderer {
  readonly key = "fixture";
  calls: string[] = [];
  async available() {
    return { ok: true as const };
  }
  async render(input: { url: string }) {
    this.calls.push(input.url);
    return input.url === AUREL
      ? { ok: true as const, html: AUREL_RENDERED, url: input.url, requests: 3, refused: 1 }
      : { ok: false as const, code: "FAILED" as const, reason: "no fixture" };
  }
}
let renderer: FixtureRenderer;

const localOllama = (url = ollama.url) => new OllamaClient(url, false, 10_000, 16_384);

beforeEach(async () => {
  await harness.reset();
  fetched.length = 0;
  ollama.requests.length = 0;
  seoAnswer = structuredClone(SEO_ANSWER_DEFAULT);
  seoRaw = null;
  clearSitemapCache();
  clearLocalSearchCache();
  const [row] = await harness.db.insert(users).values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" }).returning({ id: users.id });
  staff.id = row.id;
  categoryId = (await createCategory(staff, { name: `Catalogue ${++seq}`, slug: `catalogue-${seq}` })).id;
  renderer = new FixtureRenderer();
  setPageRendererForTesting(renderer);
  setProductExtractionProviderForTesting(new OllamaExtractionProvider(localOllama(), "qwen2.5:7b", 16_384));
  setProductResearchProviderForTesting(new LocalResearchProvider({ searxngBaseUrl: searxUrl, searxngAllowRemote: false, fetcher: sitemapFetcher }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setPageRendererForTesting(undefined);
  setProductExtractionProviderForTesting(undefined);
  setProductResearchProviderForTesting(undefined);
  setIntelligenceProviderForTesting(undefined);
});

type ListingInput = Parameters<typeof createProduct>[1];

async function listing(input: Partial<ListingInput> & { title: string; brand: string }) {
  const product = await createProduct(staff, { categoryId, ...input } as ListingInput);
  const [row] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return row;
}

async function research(pkbProductId: string) {
  const requested = await requestEnrichment(staff, { pkbProductId, requestKey: `local-${++seq}` });
  return runEnrichment(requested.runId);
}

async function approveDomain(pkbProductId: string, domain: string) {
  const [brandId] = await trustedBrandIds(harness.db, pkbProductId);
  const entry = await suggestRegistryEntry(staff, { brandId, role: "official_product", domain });
  await decideRegistryEntry(staff, entry.id, "approved");
}

const evidenceOf = (pkbProductId: string) => harness.db.select().from(pkbEvidence).where(eq(pkbEvidence.pkbProductId, pkbProductId));
const claimsOf = (pkbProductId: string) => harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId));

// -------------------------------------------------- 1. beauty, sold by shade

describe("a beauty product sold by shade, with its facts in prose", () => {
  it("is read by the local model, and grounding keeps only what the page says", async () => {
    const product = await listing({ title: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", identity: { officialUrl: REVLON } } as never);
    const report = await research(product.pkbProductId!);

    expect(report.providers).toContainEqual(
      expect.objectContaining({ provider: "extraction:ollama", status: "OK", message: "5 read from the page, 2 confirmed against its text, 3 discarded." }),
    );
    const assisted = (await evidenceOf(product.pkbProductId!)).filter((row) => row.extractionMethod === "ai_assisted");
    expect(assisted.map((row) => row.extractedLabel).sort()).toEqual(["Gray coverage", "Processing time"]);
    for (const row of assisted) expect(PAGES[REVLON].replace(/\s+/g, " ")).toContain(row.excerpt!.replace(/\s+/g, " "));
    const stored = JSON.stringify(await evidenceOf(product.pkbProductId!));
    expect(stored).not.toContain("12 weeks");
    expect(stored).not.toContain("Dermatologist tested");
    expect(stored).not.toContain("3 levels");
    // A complete static page is never rendered.
    expect(renderer.calls).toEqual([]);
  });

  it("keeps the structured reading and says the prose was not read when Ollama is not running", async () => {
    setProductExtractionProviderForTesting(new OllamaExtractionProvider(localOllama(`http://127.0.0.1:${await closedPort()}`), "qwen2.5:7b", 16_384));
    const product = await listing({ title: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", identity: { officialUrl: REVLON } } as never);
    const report = await research(product.pkbProductId!);
    const state = report.providers.find((entry) => entry.provider === "extraction:ollama");
    expect(state).toMatchObject({ status: "UNAVAILABLE", message: expect.stringMatching(/not running.*not read into facts/) });
    expect((await claimsOf(product.pkbProductId!)).map((claim) => claim.rawValue)).toContain("Black (010)");
  });
});

// ------------------------------------------ 2. electronics, with a spec page

describe("a technical product whose specifications are on a linked page", () => {
  it("follows the product's own specification link, one level, and nothing else", async () => {
    const product = await listing({ title: "Sonoline WH-4000 Wireless Headphones", brand: "Sonoline", identity: { modelNumber: "WH-4000", officialUrl: SONOLINE } } as never);
    const report = await research(product.pkbProductId!);

    expect(fetched).toContain(SONOLINE_SPECS);
    // Reviews, the blog, the category, the site-wide support page and the spec page's own links are not followed.
    expect(fetched.some((url) => /reviews|blog|collections|\/en\/support$|manual/.test(url))).toBe(false);
    expect(report.documentsRetrieved).toBe(2);
    const documents = await harness.db.select().from(pkbSourceDocuments).where(eq(pkbSourceDocuments.pkbProductId, product.pkbProductId!));
    expect(documents.map((document) => document.identityMatch)).toEqual(["match", "match"]);
    const values = (await evidenceOf(product.pkbProductId!)).map((row) => row.extractedValue);
    expect(values).toEqual(expect.arrayContaining(["40 mm", "30 hours", "USB-C"]));
    // A spec table is enough: the local model is not asked.
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(0);
  });
});

// ------------------------------------------ 3. skincare, found automatically

describe("a skincare product found by local discovery", () => {
  it("is found in the brand's official sitemap and by local search, and a search snippet is never evidence", async () => {
    const product = await listing({ title: "Northfield Botanics Daily Barrier Cream", brand: "Northfield Botanics" });
    await approveDomain(product.pkbProductId!, "northfield.test");
    const report = await research(product.pkbProductId!);

    const discovery = report.providers.find((entry) => entry.provider === "local");
    expect(discovery).toMatchObject({ status: "OK" });
    expect(fetched[0]).toBe(NORTHFIELD);
    expect(fetched).not.toContain("https://www.northfield.test/blogs/news/barrier-cream-tips");
    const documents = await harness.db.select().from(pkbSourceDocuments).where(eq(pkbSourceDocuments.pkbProductId, product.pkbProductId!));
    expect(documents.some((document) => document.identityMatch === "match")).toBe(true);
    // The reseller's snippet said "999 g"; nothing stored says so.
    const everything = JSON.stringify([await evidenceOf(product.pkbProductId!), await claimsOf(product.pkbProductId!)]);
    expect(everything).not.toContain("999 g");
    expect(everything).not.toContain("Net weight");
    expect(everything).not.toContain("Best price");
  });

  it("still finds the product in the sitemap when SearXNG is not running, and records why", async () => {
    setProductResearchProviderForTesting(
      new LocalResearchProvider({ searxngBaseUrl: `http://127.0.0.1:${await closedPort()}`, searxngAllowRemote: false, fetcher: sitemapFetcher }),
    );
    const product = await listing({ title: "Northfield Botanics Daily Barrier Cream", brand: "Northfield Botanics" });
    await approveDomain(product.pkbProductId!, "northfield.test");
    const report = await research(product.pkbProductId!);
    expect(report.providers.find((entry) => entry.provider === "local")?.message).toMatch(/1 candidate page — .*SearXNG.*not running/);
    expect(fetched).toEqual([NORTHFIELD]);
  });
});

// --------------------------------------------- 4. a JavaScript-rendered page

describe("a product page that only JavaScript fills", () => {
  it("is rendered only because its static copy is an empty shell, and read from the rendering", async () => {
    const product = await listing({ title: "Aurel Hydra Serum 30 ml", brand: "Aurel", identity: { officialUrl: AUREL } } as never);
    const report = await research(product.pkbProductId!);
    expect(renderer.calls).toEqual([AUREL]);
    expect(report.providers).toContainEqual(expect.objectContaining({ provider: "renderer:fixture", status: "OK", message: expect.stringMatching(/rendered in a local browser/) }));
    const [document] = await harness.db.select().from(pkbSourceDocuments).where(eq(pkbSourceDocuments.pkbProductId, product.pkbProductId!));
    expect(document.identityMatch).toBe("match");
    expect(document.textContent).toContain("Hyaluronic acid");
    // Its table is read like any other: evidence, and labels proposed for a person.
    const evidence = (await evidenceOf(product.pkbProductId!)).map((row) => row.extractedValue);
    expect(evidence).toEqual(expect.arrayContaining(["30 ml", "Hyaluronic acid"]));
  });

  it("reads the static page and says rendering might have helped when no renderer is set up", async () => {
    setPageRendererForTesting(null);
    const product = await listing({ title: "Aurel Hydra Serum 30 ml", brand: "Aurel", identity: { officialUrl: AUREL } } as never);
    const report = await research(product.pkbProductId!);
    expect(report.providers).toContainEqual(
      expect.objectContaining({ provider: "renderer:none", status: "NOT_CONFIGURED", message: expect.stringMatching(/shows little without JavaScript/) }),
    );
    expect(await claimsOf(product.pkbProductId!)).toEqual([]);
  });
});

// --------------------------------------- 5. SeoPulse content from a local model

const OFFICIAL = "https://harbor-acoustics.test/hp-900";

async function knownListing(extra: Partial<ListingInput> = {}) {
  return listing({
    title: "HP-900 Headphones",
    brand: "Harbor Acoustics",
    identity: { modelNumber: "HP-900", officialUrl: OFFICIAL },
    specTable: [
      { label: "Driver", value: "40 mm" },
      { label: "Connectivity", value: "Bluetooth 5.4" },
      { label: "Noise cancelling", value: "Active" },
    ],
    measurements: [{ label: "Item weight", value: "250 g" }],
    ...extra,
  } as never);
}

async function drive(runId: string) {
  for (let round = 0; round < 20; round += 1) {
    const [run] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
    if (!run || run.finishedAt || run.stage === "NEEDS_REVIEW") break;
    await harness.db.update(pkbEnrichmentRuns).set({ status: "completed", finishedAt: new Date() }).where(eq(pkbEnrichmentRuns.status, "queued"));
    await processSearchQueue();
    await advancePreparation(runId);
  }
  const [run] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return run;
}

const requestKey = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;

describe("Prepare with SeoPulse on the local engine", () => {
  it("writes the local model's grounded content into the listing, invented figures withheld, and reaches READY", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");

    const [seo] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    const analysis = seo.analysis as { generator: { kind: string; provider: string; localGrounded?: boolean }; keyFeatures: string[]; description: { suggestedHtml: string | null } };
    expect(analysis.generator).toMatchObject({ kind: "ai", provider: "Local AI (Ollama — qwen2.5:7b)", localGrounded: true });
    expect(analysis.keyFeatures).toEqual(["40 mm drivers", "Bluetooth 5.4 connectivity", "Active noise cancelling"]);

    // READY means the listing itself holds the content, not that recommendations exist (D-125).
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml).toContain("LOCAL-MODEL: The Harbor Acoustics HP-900 headphones pair 40 mm drivers");
    expect(after.bulletFeatures).toEqual(["40 mm drivers", "Bluetooth 5.4 connectivity", "Active noise cancelling"]);
    expect(after.seoMetaTitle).toBe("Harbor Acoustics HP-900 Headphones");
    expect(after.seoMetaDescription).toBe(SEO_ANSWER_DEFAULT.metaDescription.recommended);
    expect(after.seoFocusKeyword).toMatch(/^harbor acoustics hp.900 headphones$/);
    expect(after.tags).toEqual(["headphones", "noise cancelling"]);
    expect(after.searchKeywords).toEqual(["hp900 headphones", "harbor acoustics hp 900"]);
    // The invented "30-hour battery" was withheld and never reached the listing.
    expect(JSON.stringify(after)).not.toContain("30-hour");

    const step = run.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.applied).toEqual(
      expect.arrayContaining(["Description", "Key features", "SEO title", "Meta description", "Focus keyword", "Tags", "Search terms"]),
    );
    expect(step.fields?.review).toEqual([]);
    // Nothing is left waiting in the editor for these fields.
    const recommendations = await seoPulseRecommendations(staff, product.id);
    expect(recommendations?.fields.map((entry) => entry.field)).not.toEqual(expect.arrayContaining(["descriptionHtml"]));
    // Each write is recorded as SeoPulse's, so a later preparation may refresh it.
    const owners = await contentOwnership(harness.db, product.id, ["descriptionHtml", "bulletFeatures", "seoMetaTitle", "tags"] as const);
    expect([...owners.values()]).toEqual(["seo_pulse", "seo_pulse", "seo_pulse", "seo_pulse"]);
    // The model was shown established knowledge, not the listing's free text.
    const sent = ollama.requests.filter((request) => request.path === "/api/chat").at(-1)!.body!;
    expect(sent.messages[1].content).toContain("Bluetooth 5.4");
  });

  it("keeps a staff-written description and a locked meta description, and fills the rest", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await knownListing({ descriptionHtml: "<p>Our own words about the HP-900.</p>" } as never);
    await updateProduct(staff, product.id, { seoMetaDescription: "Staff meta: Harbor Acoustics HP-900 headphones, checked with the supplier." });
    await setFieldLock(staff, product.id, "seoMetaDescription", true, "Checked with the supplier.");
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml).toBe("<p>Our own words about the HP-900.</p>");
    expect(after.seoMetaDescription).toBe("Staff meta: Harbor Acoustics HP-900 headphones, checked with the supplier.");
    expect(after.bulletFeatures).toEqual(["40 mm drivers", "Bluetooth 5.4 connectivity", "Active noise cancelling"]);
    expect(after.seoMetaTitle).toBe("Harbor Acoustics HP-900 Headphones");
    const step = run.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.kept).toContain("Description");
    expect(step.fields?.applied).not.toContain("Meta description");
  });

  it("refreshes its own earlier wording and lists, and leaves wording staff edited since", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await knownListing();
    const first = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(first.stage).toBe("READY");

    // Staff rewrite the description SeoPulse wrote; the history now says it is theirs.
    await updateProduct(staff, product.id, { descriptionHtml: "<p>Edited by staff after SeoPulse.</p>" });
    seoAnswer.description.suggestedHtml = "<p>LOCAL-MODEL again: The Harbor Acoustics HP-900 headphones.</p>";
    seoAnswer.seoTitle.recommended = "Harbor Acoustics HP-900 Wireless Headphones";
    seoAnswer.keyFeatures = ["40 mm drivers", "Active noise cancelling"];
    seoAnswer.tags = ["wireless headphones"];
    seoAnswer.searchAliases = ["harbor hp900"];

    const second = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(second.stage).toBe("READY");
    expect(second.seoRunId).not.toBe(first.seoRunId);
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml).toBe("<p>Edited by staff after SeoPulse.</p>");
    expect(after.seoMetaTitle).toBe("Harbor Acoustics HP-900 Wireless Headphones");
    expect(after.bulletFeatures).toEqual(["40 mm drivers", "Active noise cancelling"]);
    // SeoPulse's own lists are replaced by the current ones (D-123), stale terms gone.
    expect(after.tags).toEqual(["wireless headphones"]);
    expect(after.searchKeywords).toContain("harbor hp900");
    expect(after.searchKeywords).not.toContain("hp900 headphones");
    const step = second.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.kept).toContain("Description");
    expect(step.fields?.refreshed).toEqual(expect.arrayContaining(["SEO title", "Key features", "Tags", "Search terms"]));
  });

  it("writes nothing from a malformed answer, and labels the run as rule-based", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    seoRaw = '{"primaryKeyword":{"keyword":"MALFORMED-MODEL-OUTPUT","intent":"product"},"description":{"suggestedHtml":"<p>MALFORMED-MODEL-OUTPUT';
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    const [seo] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    const analysis = seo.analysis as { generator: { kind: string; localGrounded?: boolean } };
    expect(analysis.generator).toMatchObject({ kind: "rules", localGrounded: false });
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(JSON.stringify(after)).not.toContain("MALFORMED-MODEL-OUTPUT");
    expect(JSON.stringify(seo.analysis)).not.toContain("MALFORMED-MODEL-OUTPUT");
  });

  it("writes no content when too little is established, whatever the model would say", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await listing({ title: "HP-900 Headphones", brand: "Harbor Acoustics", identity: { modelNumber: "HP-900", officialUrl: OFFICIAL } } as never);
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toContain("INSUFFICIENT_KNOWLEDGE");
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml ?? "").toBe("");
    expect(after.bulletFeatures ?? []).toEqual([]);
    expect(after.seoMetaDescription ?? "").toBe("");
    expect(JSON.stringify(after)).not.toContain("LOCAL-MODEL");
    // The model was not asked to write anything.
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(0);
  });

  it("stops for labels no attribute names yet, and writes no content", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await listing({ title: "Aurel Hydra Serum 30 ml", brand: "Aurel", identity: { officialUrl: AUREL } } as never);
    await research(product.pkbProductId!);
    const open = await harness.db
      .select()
      .from(pkbAttributeProposals)
      .where(and(eq(pkbAttributeProposals.pkbProductId, product.pkbProductId!), eq(pkbAttributeProposals.status, "open")));
    expect(open.length).toBeGreaterThan(0);
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toContain("LABELS_WAITING");
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml ?? "").toBe("");
    expect(after.bulletFeatures ?? []).toEqual([]);
  });

  it("does not write local wording when the identity is questioned while it is being generated", async () => {
    /** Ollama, and meanwhile someone's decision reopens which product this is. */
    class Questioned extends OllamaIntelligenceProvider {
      async analyzeProduct(...args: Parameters<OllamaIntelligenceProvider["analyzeProduct"]>) {
        const answer = await super.analyzeProduct(...args);
        const [row] = await harness.db.select({ pkbProductId: products.pkbProductId }).from(products).where(eq(products.id, args[0].productId));
        await harness.db.update(pkbProducts).set({ resolutionState: "AMBIGUOUS" }).where(eq(pkbProducts.id, row.pkbProductId!));
        return answer;
      }
    }
    setIntelligenceProviderForTesting(new Questioned(localOllama(), "qwen2.5:7b"));
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review).toContainEqual(
      expect.objectContaining({ code: "CONTENT_NOT_APPLIED", message: expect.stringMatching(/has not been settled/) }),
    );
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml ?? "").toBe("");
    expect(after.bulletFeatures ?? []).toEqual([]);
    // Offered field by field instead.
    const recommendations = await seoPulseRecommendations(staff, product.id);
    expect(recommendations?.fields.map((entry) => entry.field)).toEqual(expect.arrayContaining(["descriptionHtml", "bulletFeatures"]));
  });

  it("uses the rules generator and does not claim AI copy when Ollama is not running", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(`http://127.0.0.1:${await closedPort()}`), "qwen2.5:7b"));
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");
    const [seo] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    const analysis = seo.analysis as { generator: { kind: string; label: string } };
    expect(analysis.generator.kind).toBe("rules");
    expect(analysis.generator.label).toMatch(/Rule-based/);
    const usage = seo.providerUsage as { id: string; status: string; message: string }[];
    expect(usage).toContainEqual(expect.objectContaining({ id: "ollama", status: "failed", message: expect.stringMatching(/rules generator was used instead/) }));
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml ?? "").not.toContain("LOCAL-MODEL");
  });
});

describe("the other generators, unchanged by D-125", () => {
  it("leaves a hosted model's prose for review, as before", async () => {
    const hosted = new AnthropicIntelligenceProvider("test-key-not-used", "claude-sonnet-5");
    vi.spyOn(hosted, "analyzeProduct").mockImplementation(async (input) => ({
      generated: sanitizeGenerated(structuredClone(SEO_ANSWER_DEFAULT), input),
      model: "claude-sonnet-5",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
    }));
    setIntelligenceProviderForTesting(hosted);
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");
    const [seo] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    expect((seo.analysis as { generator: object }).generator).toMatchObject({ kind: "ai", localGrounded: false });
    const step = run.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.review).toEqual(expect.arrayContaining(["Description", "Key features", "SEO title", "Meta description"]));
    expect(step.fields?.applied).toEqual([]);
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml ?? "").toBe("");
    expect(after.bulletFeatures ?? []).toEqual([]);
    expect(after.tags ?? []).toEqual([]);
  });

  it("writes the rules generator's wording, as before", async () => {
    setIntelligenceProviderForTesting(new RulesIntelligenceProvider());
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");
    const [seo] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    expect((seo.analysis as { generator: object }).generator).toMatchObject({ kind: "rules", localGrounded: false });
    const step = run.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.review).toEqual([]);
    expect(step.fields?.applied).toEqual(expect.arrayContaining(["SEO title", "Focus keyword"]));
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.seoMetaTitle ?? "").not.toBe("");
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(0);
  });
});

describe("with no paid key anywhere", () => {
  it("prepares a product from local discovery to READY", async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.BRAVE_SEARCH_API_KEY).toBeUndefined();
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(localOllama(), "qwen2.5:7b"));
    const product = await knownListing();
    const run = await drive((await startPreparation(staff, product.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");
    expect(await harness.db.select().from(pkbEnrichmentRuns).where(and(eq(pkbEnrichmentRuns.pkbProductId, product.pkbProductId!)))).toHaveLength(1);
    // The listing a READY run leaves behind holds the prepared content itself.
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after.descriptionHtml).toContain("LOCAL-MODEL");
    expect(after.bulletFeatures).toHaveLength(3);
  });
});
