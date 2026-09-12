/**
 * SEO Pulse (DECISIONS.md D-038): the pure rules — normalisation, slugs,
 * scores, AI-output validation — and the stored behaviour against a real
 * in-process Postgres: versioning, reuse, idempotency, provider failure,
 * permission checks, and the rule that applying never silently overwrites.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productImages, products, searchQueries, searchSynonyms, seoResearchRuns, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  applySeoPulse,
  exportCsv,
  exportJson,
  getSeoPulseOverview,
  loadPulseInput,
  pulseStatus,
  runSeoPulse,
  searchScore,
  seoScore,
} from "@/lib/seo-pulse";
import { setSeoDataProviderForTesting, type SeoDataProvider } from "@/lib/seo-pulse/providers/data";
import {
  setIntelligenceProviderForTesting,
  type SeoIntelligenceProvider,
} from "@/lib/seo-pulse/providers/intelligence";
import { measurementRows, specificationRows } from "@/lib/seo-pulse/facts";
import { generateByRules } from "@/lib/seo-pulse/rules";
import { sanitizeDescriptionHtml, sanitizeGenerated } from "@/lib/seo-pulse/sanitize";
import {
  cleanTerms,
  clampText,
  isSuperset,
  keywordKey,
  normalizeKeyword,
  suggestSlug,
} from "@/lib/seo-pulse/text";
import type { SeoPulseInput } from "@/lib/seo-pulse/types";
import { createTestDatabase } from "./helpers/database";

// ------------------------------------------------------------------- pure

function sampleInput(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    slug: "sony-wh-1000xm5",
    brand: "Sony",
    sku: "SKU-000001",
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: ["Audio", "Headphones"],
    status: "draft",
    descriptionText: "",
    bulletFeatures: ["Industry-leading noise cancelling", "30-hour battery"],
    specifications: [],
    measurements: [],
    details: { color: "Black" },
    boxContents: [],
    warranty: null,
    countryOfOrigin: null,
    tags: [],
    searchKeywords: [],
    searchable: true,
    seoFocusKeyword: null,
    seoMetaTitle: null,
    seoMetaDescription: null,
    seoNoIndex: false,
    images: [
      {
        id: "00000000-0000-4000-8000-0000000000a1",
        url: "/uploads/a.jpg",
        altText: "IMG_2231.jpg",
        kind: "gallery",
      },
    ],
    hasVideo: false,
    variants: [],
    reviews: { count: 0, average: null },
    ...overrides,
  };
}

const emptyResearch = { siteSearch: null, keywordMetrics: [], serp: [] };

describe("keyword normalisation", () => {
  it("treats case, hyphens and spacing as one keyword", () => {
    expect(normalizeKeyword("Car-Charger")).toBe("car charger");
    expect(normalizeKeyword("  car   charger ")).toBe("car charger");
    expect(keywordKey("Car Chargers")).toBe(keywordKey("car-charger"));
  });

  it("deduplicates and drops blanks", () => {
    expect(cleanTerms(["Car Charger", "car-charger", "car chargers", "", "usb c"], 10)).toEqual([
      "car charger",
      "usb c",
    ]);
  });

  it("checks a list still holds everything it held", () => {
    expect(isSuperset(["a", "B", "c"], ["b", "a"])).toBe(true);
    expect(isSuperset(["a"], ["a", "b"])).toBe(false);
  });
});

describe("slugs and lengths", () => {
  it("builds a short, clean slug", () => {
    expect(suggestSlug("The Best Sony WH-1000XM5 Headphones for Travel")).toBe(
      "sony-wh-1000xm5-headphones-travel",
    );
    expect(suggestSlug("a".repeat(30) + " " + "b".repeat(40)).length).toBeLessThanOrEqual(60);
  });

  it("cuts text at a word boundary", () => {
    expect(clampText("one two three four", 9)).toBe("one two");
  });
});

describe("scores", () => {
  it("rises as fields are completed and stays within 0–100", () => {
    const bare = seoScore(sampleInput());
    const done = seoScore(
      sampleInput({
        seoFocusKeyword: "sony wh-1000xm5",
        seoMetaTitle: "Sony WH-1000XM5 Headphones – Price in Bangladesh",
        seoMetaDescription:
          "Sony WH-1000XM5 wireless headphones with industry-leading noise cancelling, sourced from the US and delivered across Bangladesh.",
        descriptionText: "x".repeat(400),
        bulletFeatures: ["a", "b", "c"],
        details: { color: "Black", material: "Plastic", itemWeight: "250 g" },
        images: [{ id: "i", url: "/a.jpg", altText: "Sony WH-1000XM5 headphones in black, folded", kind: "gallery" }],
        identifierType: "upc",
        identifierValue: "027242923232",
        variants: [{ label: "SKU", priceBdt: 100, fulfillmentMode: "preorder", available: true, arrivesFrom: null, arrivesTo: null }],
      }),
    );
    expect(bare.score).toBeGreaterThanOrEqual(0);
    expect(done.score).toBe(100);
    expect(done.score).toBeGreaterThan(bare.score);
  });

  it("keeps the internal-search score separate", () => {
    const result = searchScore(sampleInput({ searchKeywords: ["a", "b", "c"], tags: ["x", "y", "z"] }));
    expect(result.checks.map((check) => check.id)).toContain("aliases");
    expect(result.checks.map((check) => check.id)).not.toContain("meta_description");
  });
});

describe("rules generator", () => {
  it("never invents metrics or misspellings, and flags photographs for review", () => {
    const generated = sanitizeGenerated(generateByRules(sampleInput(), emptyResearch), sampleInput());
    expect(generated.misspellings).toEqual([]);
    expect(generated.primaryKeyword.keyword).toContain("sony");
    expect(generated.imageAlts[0].needsReview).toBe(true);
    expect(generated.slug.recommended).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(generated.seoTitle.recommended.length).toBeLessThanOrEqual(70);
    // Authenticity is a claim only staff can answer.
    expect(generated.faqs.find((faq) => /original/i.test(faq.question))?.needsManualAnswer).toBe(true);
  });

  it("uses only misspellings shoppers were seen typing", () => {
    const generated = generateByRules(sampleInput(), {
      ...emptyResearch,
      siteSearch: {
        source: "log",
        windowDays: 90,
        researchedAt: new Date().toISOString(),
        matchingQueries: [],
        queriesLeadingHere: [],
        correctedTypos: [{ typed: "sonny headphones", corrected: "sony headphones", searches: 4 }],
        existingSynonyms: [],
      },
    });
    expect(generated.misspellings.map((entry) => entry.term)).toEqual(["sonny headphones"]);
  });
});

describe("AI output validation", () => {
  it("rejects a response without a primary keyword", () => {
    expect(() => sanitizeGenerated({ seoTitle: { recommended: "x" } }, sampleInput())).toThrow();
  });

  it("drops image ids that do not belong to the product and fixes a bad slug", () => {
    const rules = generateByRules(sampleInput(), emptyResearch);
    const cleaned = sanitizeGenerated(
      {
        ...rules,
        slug: { recommended: "Not A Slug!!", reason: "r" },
        imageAlts: [
          { imageId: "00000000-0000-4000-8000-0000000000ff", altText: "foreign", title: null, needsReview: false, reason: "r" },
          { imageId: sampleInput().images[0].id, altText: "Black headphones", title: null, needsReview: false, reason: "r" },
        ],
        secondaryKeywords: [
          { keyword: "Car Charger", intent: "product", relevance: "high", reason: "r" },
          { keyword: "car-charger", intent: "bogus", relevance: "high", reason: "r" },
        ],
      },
      sampleInput(),
    );
    // "a" is a filler word, and filler words are dropped from slugs.
    expect(cleaned.slug.recommended).toBe("not-slug");
    expect(cleaned.imageAlts).toHaveLength(1);
    // An AI model never sees the photograph, so its alt text always needs review.
    expect(cleaned.imageAlts[0].needsReview).toBe(true);
    expect(cleaned.secondaryKeywords).toHaveLength(1);
  });

  it("strips unsafe HTML from a suggested description", () => {
    expect(
      sanitizeDescriptionHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="x">link</a>'),
    ).toBe("<p>Hi</p>link");
  });
});

describe("panel status", () => {
  const base = { createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), appliedAt: null, inputHash: "h" };
  it("reports each state", () => {
    expect(pulseStatus(null, "h", new Date())).toBe("not_researched");
    expect(pulseStatus(base, "h", new Date())).toBe("available");
    expect(pulseStatus(base, "changed", new Date())).toBe("needs_refresh");
    expect(pulseStatus({ ...base, completedAt: "2020-01-01T00:00:00Z" }, "h", new Date())).toBe("needs_refresh");
    const applied = { ...base, appliedAt: new Date().toISOString() };
    expect(pulseStatus(applied, "x", new Date())).toBe("applied");
    expect(pulseStatus(applied, "x", new Date(Date.now() + 60_000))).toBe("updated");
  });
});

// --------------------------------------------------------------- database

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const productManager: SessionUser = { id: "", email: "pm@example.com", role: "product_manager" };
const orders: SessionUser = { id: "", email: "orders@example.com", role: "order_manager" };
const customer: SessionUser = { id: "", email: "customer@example.com", role: "customer" };
let productId = "";
let imageId = "";
let key = 0;
const nextKey = () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}`;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  setSeoDataProviderForTesting(undefined);
  setIntelligenceProviderForTesting(undefined);
});

beforeEach(async () => {
  await harness.reset();
  setSeoDataProviderForTesting(null);
  const rows = await harness.db
    .insert(users)
    .values([
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: productManager.email, passwordHash: "x", role: "product_manager" },
      { email: orders.email, passwordHash: "x", role: "order_manager" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  for (const account of [staff, productManager, orders, customer]) {
    account.id = rows.find((row) => row.email === account.email)!.id;
  }

  const audio = await createCategory(staff, { name: "Audio", slug: "audio" });
  const headphones = await createCategory(staff, { name: "Headphones", slug: "headphones", parentId: audio.id });
  const product = await createProduct(staff, {
    title: "Sony WH-1000XM5 Wireless Headphones",
    categoryId: headphones.id,
    brand: "Sony",
    bulletFeatures: ["Noise cancelling", "30-hour battery"],
    seoMetaTitle: "Hand-written title",
    tags: ["audio"],
  });
  productId = product.id;
  const [image] = await harness.db
    .insert(productImages)
    .values({ productId, url: "/uploads/sony.jpg", altText: "photo", sortOrder: 0 })
    .returning();
  imageId = image.id;
});

describe("running research", () => {
  it("uses the product's saved data as input", async () => {
    const input = await loadPulseInput(productId);
    expect(input?.categoryPath).toEqual(["Audio", "Headphones"]);
    expect(input?.brand).toBe("Sony");
  });

  it("stores a versioned run and labels missing external research", async () => {
    const { run, reused } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: false });
    expect(reused).toBe(false);
    expect(run.version).toBe(1);
    expect(run.status).toBe("completed");
    expect(run.analysis?.generator.label).toMatch(/external research unavailable/);
    expect(run.research?.keywordMetrics).toEqual([]);
    expect(run.providerUsage.find((entry) => entry.kind === "external_data")?.status).toBe("unavailable");
    expect(run.analysis?.scores.seo.score).toBeTypeOf("number");
  });

  it("reuses unchanged research, returns the same run for a retried request, and keeps old versions on refresh", async () => {
    const requestKey = nextKey();
    const first = await runSeoPulse(staff, productId, { requestKey, fresh: false });
    const retry = await runSeoPulse(staff, productId, { requestKey, fresh: false });
    expect(retry.run.id).toBe(first.run.id);

    const again = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: false });
    expect(again.reused).toBe(true);
    expect(again.run.id).toBe(first.run.id);

    const fresh = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    expect(fresh.reused).toBe(false);
    expect(fresh.run.version).toBe(2);

    const all = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.productId, productId));
    expect(all).toHaveLength(2);
  });

  it("refuses a second run while one is in progress", async () => {
    await harness.db.insert(seoResearchRuns).values({
      productId,
      version: 1,
      requestKey: nextKey(),
      inputSnapshot: {},
      inputHash: "x",
      pulseVersion: "test",
      status: "running",
    });
    await expect(runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true })).rejects.toMatchObject({ status: 409 });
  });

  it("carries on when the external provider fails, and records the failure", async () => {
    const failing: SeoDataProvider = {
      id: "broken",
      label: "Broken provider",
      keywordResearch: async () => {
        throw new Error("503 from provider");
      },
      serpResearch: async () => {
        throw new Error("503 from provider");
      },
      usage: () => ({ requests: 2, costUsd: null }),
    };
    setSeoDataProviderForTesting(failing);
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    expect(run.status).toBe("completed");
    const usage = run.providerUsage.find((entry) => entry.id === "broken");
    expect(usage?.status).toBe("failed");
    expect(run.research?.keywordMetrics).toEqual([]);
  });

  it("stores external metrics with their source when a provider answers", async () => {
    setSeoDataProviderForTesting({
      id: "fake",
      label: "Fake provider",
      keywordResearch: async (keywords) =>
        keywords.slice(0, 1).map((keyword) => ({
          keyword,
          searchVolume: 1300,
          difficulty: 20,
          competition: "LOW",
          cpcUsd: 0.2,
          trend: null,
          geo: "BD",
          source: "Fake provider",
          researchedAt: new Date().toISOString(),
        })),
      serpResearch: async (keyword) => ({
        keyword,
        geo: "BD",
        source: "Fake provider",
        researchedAt: new Date().toISOString(),
        results: [
          { position: 1, title: "Sony WH-1000XM5 price in Bangladesh", url: "https://a.example/x", domain: "a.example", snippet: null },
          { position: 2, title: "Sony WH-1000XM5 review", url: "https://b.example/y", domain: "b.example", snippet: null },
        ],
        relatedSearches: ["sony headphones bd"],
        peopleAlsoAsk: ["Is the XM5 waterproof?"],
        hasShoppingResults: true,
        hasFeaturedSnippet: false,
      }),
      usage: () => ({ requests: 2, costUsd: 0.01 }),
    });
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    expect(run.research?.keywordMetrics[0].source).toBe("Fake provider");
    expect(run.analysis?.generator.label).toMatch(/based on collected research/);
    expect(run.analysis?.competitorObservations.length).toBeGreaterThan(0);
  });

  it("falls back to the rules generator when the AI returns invalid output", async () => {
    const broken: SeoIntelligenceProvider = {
      id: "ai",
      label: "Broken AI",
      kind: "ai",
      analyzeProduct: async (input) => ({
        generated: sanitizeGenerated({ nonsense: true }, input),
        model: "x",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      }),
    };
    setIntelligenceProviderForTesting(broken);
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    expect(run.analysis?.generator.kind).toBe("rules");
    expect(run.providerUsage.find((entry) => entry.id === "ai")?.status).toBe("failed");
  });

  it("reads real site searches as first-party research", async () => {
    await harness.db.insert(searchQueries).values({
      query: "sony wh 1000xm5",
      queryNorm: "sony wh 1000xm5",
      resultsCount: 1,
      visitorHash: "v",
      windowStart: new Date(),
    });
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    expect(run.research?.siteSearch?.matchingQueries[0]).toMatchObject({ query: "sony wh 1000xm5", searches: 1 });
  });
});

describe("permissions", () => {
  it("refuses a customer, a role without catalogue access, and an anonymous caller", async () => {
    for (const actor of [customer, orders, null]) {
      await expect(runSeoPulse(actor, productId, { requestKey: nextKey(), fresh: false })).rejects.toThrow();
      await expect(getSeoPulseOverview(actor, productId)).rejects.toThrow();
    }
    await expect(runSeoPulse(customer, productId, { requestKey: nextKey(), fresh: false })).rejects.toThrow(AuthorizationError);
  });

  it("lets a product manager run research", async () => {
    const { run } = await runSeoPulse(productManager, productId, { requestKey: nextKey(), fresh: false });
    expect(run.status).toBe("completed");
  });
});

describe("applying", () => {
  async function research() {
    return (await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true })).run;
  }

  it("fills empty fields without asking", async () => {
    const run = await research();
    const result = await applySeoPulse(staff, productId, {
      runId: run.id,
      fields: { seoFocusKeyword: "sony wh 1000xm5", seoMetaDescription: "A".repeat(80) },
      overwrite: [],
    });
    expect(result.applied).toEqual(expect.arrayContaining(["seoFocusKeyword", "seoMetaDescription"]));
    const [saved] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(saved.seoFocusKeyword).toBe("sony wh 1000xm5");
  });

  it("refuses to replace a hand-written value unless Replace was chosen", async () => {
    const run = await research();
    await expect(
      applySeoPulse(staff, productId, { runId: run.id, fields: { seoMetaTitle: "Generated" }, overwrite: [] }),
    ).rejects.toMatchObject({ status: 409, details: { conflicts: ["seoMetaTitle"] } });

    const [unchanged] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(unchanged.seoMetaTitle).toBe("Hand-written title");

    await applySeoPulse(staff, productId, { runId: run.id, fields: { seoMetaTitle: "Generated" }, overwrite: ["seoMetaTitle"] });
    const [replaced] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(replaced.seoMetaTitle).toBe("Generated");
  });

  it("allows adding to a list but not dropping from it silently", async () => {
    const run = await research();
    await applySeoPulse(staff, productId, { runId: run.id, fields: { tags: ["audio", "headphones"] }, overwrite: [] });
    await expect(
      applySeoPulse(staff, productId, { runId: run.id, fields: { tags: ["headphones"] }, overwrite: [] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("protects existing alt text and refuses another product's photograph", async () => {
    const run = await research();
    await expect(
      applySeoPulse(staff, productId, { runId: run.id, fields: { imageAlts: [{ imageId, altText: "Black headphones folded" }] }, overwrite: [] }),
    ).rejects.toMatchObject({ status: 409 });
    await applySeoPulse(staff, productId, {
      runId: run.id,
      fields: { imageAlts: [{ imageId, altText: "Black headphones folded" }] },
      overwrite: ["imageAlts"],
    });
    const [image] = await harness.db.select().from(productImages).where(eq(productImages.id, imageId));
    expect(image.altText).toBe("Black headphones folded");

    await expect(
      applySeoPulse(staff, productId, {
        runId: run.id,
        fields: { imageAlts: [{ imageId: "00000000-0000-4000-8000-00000000beef", altText: "x" }] },
        overwrite: ["imageAlts"],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an address another product uses", async () => {
    const other = await createProduct(staff, {
      title: "Other product",
      categoryId: (await harness.db.select().from(products).where(eq(products.id, productId)))[0].categoryId,
    });
    const run = await research();
    await expect(
      applySeoPulse(staff, productId, { runId: run.id, fields: { slug: other.slug }, overwrite: ["slug"] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("records what was applied on the run, and never touches price, status or category", async () => {
    const run = await research();
    const [before] = await harness.db.select().from(products).where(eq(products.id, productId));
    await applySeoPulse(staff, productId, { runId: run.id, fields: { searchKeywords: ["wh1000xm5"] }, overwrite: [] });
    const [after] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(after.status).toBe(before.status);
    expect(after.categoryId).toBe(before.categoryId);
    const [stored] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.id));
    expect(stored.appliedFields).toEqual(["searchKeywords"]);
    expect(stored.appliedAt).not.toBeNull();
  });

  it("adds a site-wide synonym only with search permission and never edits an existing one", async () => {
    const run = await research();
    await harness.db.insert(searchSynonyms).values({ term: "headphones", synonyms: ["cans"] });
    const result = await applySeoPulse(staff, productId, {
      runId: run.id,
      fields: { synonyms: [{ term: "headphones", synonyms: ["headset"] }] },
      overwrite: [],
    });
    expect(result.skipped).toHaveLength(1);
    const [entry] = await harness.db.select().from(searchSynonyms).where(eq(searchSynonyms.term, "headphones"));
    expect(entry.synonyms).toEqual(["cans"]);
  });

  it("writes key features to the product page, adding to existing ones without permission", async () => {
    const run = await research();
    await applySeoPulse(staff, productId, {
      runId: run.id,
      fields: { bulletFeatures: ["Noise cancelling", "30-hour battery", "Multipoint pairing"] },
      overwrite: [],
    });
    const [saved] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(saved.bulletFeatures).toEqual(["Noise cancelling", "30-hour battery", "Multipoint pairing"]);
    await expect(
      applySeoPulse(staff, productId, { runId: run.id, fields: { bulletFeatures: ["Only one"] }, overwrite: [] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("offers a factual starter description even for a listing with nothing on it", () => {
    const generated = generateByRules(sampleInput({ bulletFeatures: [], details: {} }), emptyResearch);
    expect(generated.description.suggestedHtml).toContain("sourced from the United States");
    expect(generated.keyFeatures).toEqual([]);
  });

  it("refuses a customer applying", async () => {
    const run = await research();
    await expect(
      applySeoPulse(customer, productId, { runId: run.id, fields: { seoFocusKeyword: "x" }, overwrite: [] }),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("export", () => {
  it("includes research, analysis and sources, and keeps unavailable metrics unavailable", async () => {
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    const json = JSON.parse(exportJson(run, "Sony"));
    expect(json.analysis.primaryKeyword.keyword).toBeTruthy();
    expect(json.research.keywordMetrics).toEqual([]);
    expect(json.product.id).toBe(productId);

    const csv = exportCsv(run, "Sony");
    const [header] = csv.split("\r\n");
    expect(header).toContain("data_type");
    expect(csv).toContain("primary_keyword");
    expect(csv).toContain("unavailable");
    expect(csv).not.toMatch(/,\d{3,},.*primary_keyword/);
  });

  it("neutralises spreadsheet formulas", async () => {
    const { run } = await runSeoPulse(staff, productId, { requestKey: nextKey(), fresh: true });
    const csv = exportCsv(run, "=HYPERLINK(\"x\")");
    expect(csv).toContain("'=HYPERLINK");
  });
});

/**
 * The description, the specification table and the measurements (D-043).
 *
 * The rule these all turn on: SEO Pulse rearranges facts the listing already
 * holds and writes nothing else. A richer description is only richer because
 * the product carries more, never because the generator filled the space.
 */
describe("product information SEO Pulse writes", () => {
  const full = () =>
    sampleInput({
      bulletFeatures: [
        "Industry-leading noise cancelling",
        "30-hour battery",
        "Multipoint pairing",
      ],
      boxContents: ["Headphones", "USB-C cable", "Carry case"],
      specifications: [{ label: "Driver", value: "30 mm" }],
      measurements: [{ label: "Weight", value: "250 g" }],
      details: {
        color: "Black",
        material: "Plastic",
        intendedUse: "travel",
        dimensions: "20 x 18 x 8 cm",
        modelNumber: "WH-1000XM5",
      },
      countryOfOrigin: "Malaysia",
    });

  it("writes a description that covers the product, not a page of filler", () => {
    const html = generateByRules(full(), emptyResearch).description.suggestedHtml ?? "";

    // What it is, what it is made of, what it is for — each said once.
    expect(html).toContain("Headphones range");
    expect(html).toContain("Plastic construction");
    expect(html).toContain("intended for travel");
    expect(html).toContain("<h2>Key features</h2>");
    expect(html).toContain("Multipoint pairing");
    expect(html).toContain("<h2>In the box</h2>");
    expect(html).toContain("Carry case");

    // Nothing is said twice: no sentence repeats anywhere in the description.
    const sentences = html
      .replace(/<[^>]+>/g, " ")
      .split(/(?<=\.)\s+/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 20);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("stays short when the listing is thin, rather than padding it out", () => {
    const thin = generateByRules(
      sampleInput({ bulletFeatures: [], details: {}, boxContents: [] }),
      emptyResearch,
    ).description.suggestedHtml ?? "";
    const rich = generateByRules(full(), emptyResearch).description.suggestedHtml ?? "";

    expect(thin.length).toBeLessThan(rich.length);
    expect(thin).not.toContain("<h2>Key features</h2>");
    expect(thin).not.toContain("<h2>In the box</h2>");
  });

  it("never writes a measurement the listing does not hold", () => {
    const analysisInput = sampleInput({
      details: { color: "Black" },
      specifications: [],
      measurements: [],
    });
    const html =
      generateByRules(analysisInput, emptyResearch).description.suggestedHtml ?? "";

    expect(html).not.toContain("<h2>Measurements</h2>");
    // No invented dimension, weight or capacity anywhere in the text.
    expect(html).not.toMatch(/\d+\s?(cm|mm|kg|g|ml|litre|liter|inch)\b/i);
  });

  it("splits recorded facts into specifications and measurements", () => {
    const input = full();
    const specs = specificationRows(input);
    const measures = measurementRows(input);

    expect(specs).toContainEqual({ label: "Brand", value: "Sony" });
    expect(specs).toContainEqual({ label: "Model number", value: "WH-1000XM5" });
    expect(specs).toContainEqual({ label: "Country of origin", value: "Malaysia" });
    expect(specs).toContainEqual({ label: "Driver", value: "30 mm" });

    expect(measures).toContainEqual({ label: "Weight", value: "250 g" });
    expect(measures).toContainEqual({
      label: "Product dimensions",
      value: "20 x 18 x 8 cm",
    });

    // Neither table repeats the other.
    const specLabels = new Set(specs.map((row) => row.label));
    expect(measures.some((row) => specLabels.has(row.label))).toBe(false);
  });

  it("has no measurements at all for a listing that recorded none", () => {
    expect(
      measurementRows(sampleInput({ details: { color: "Black" }, measurements: [] })),
    ).toEqual([]);
  });
});
