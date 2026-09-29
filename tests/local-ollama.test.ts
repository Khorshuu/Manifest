/**
 * D-124: local AI through Ollama, against a fake Ollama on a loopback port.
 *
 * What is proved: no key is needed or sent; only a loopback address is used
 * unless remote use is explicitly allowed; model availability is detected;
 * structured answers are validated, a malformed one is asked for once more and
 * then fails with nothing kept; whatever the model says is still grounded
 * against the page; SeoPulse's local answer goes through sanitizeGenerated and
 * has unsupported figures withheld; and there is never a cloud fallback.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extractDocument } from "@/lib/pkb/extract";
import { groundCandidates } from "@/lib/pkb/grounding";
import { EMPTY_GROUNDED, type GroundedKnowledge } from "@/lib/pkb/publish";
import { OllamaExtractionProvider } from "@/lib/providers/extraction/ollama";
import { localServiceUrl } from "@/lib/providers/local/config";
import { chatJson, modelInstalled, OllamaClient, readChatStream } from "@/lib/providers/local/ollama";
import { groundedPromptInput, OllamaIntelligenceProvider, withholdUnsupportedFigures } from "@/lib/seo-pulse/providers/ollama";
import type { SeoPulseInput } from "@/lib/seo-pulse/types";
import { closedPort, startFakeOllama, type FakeOllama } from "./helpers/fake-ollama";
import { createTestDatabase } from "./helpers/database";

const REVLON_URL = "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451";
const revlon = extractDocument(readFileSync("tests/fixtures/revlon-colorsilk.html", "utf8"), "text/html", { url: REVLON_URL });

let ollama: FakeOllama;
// Every model call takes the local-AI slot, which lives in the database (D-127).
let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
  ollama = await startFakeOllama({ models: ["qwen2.5:7b", "llama3.1:latest"] });
});
afterAll(async () => {
  await ollama.close();
  await harness.close();
});
afterEach(() => {
  ollama.requests.length = 0;
  ollama.chat = () => ({ content: '{"candidates":[]}' });
  vi.unstubAllEnvs();
  vi.resetModules();
});

const client = (url = ollama.url, allowRemote = false) => new OllamaClient(url, allowRemote, 5_000, 16_384);

const extractionRequest = {
  product: { name: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", family: "Beauty & Care", variant: "Black" },
  document: { url: REVLON_URL, title: "ColorSilk", text: revlon.text },
  knownLabels: ["Color"],
  maxCandidates: 40,
};

const c = (label: string, value: string, excerpt: string, kind = "product_fact") => ({ label, value, unit: null, excerpt, section: null, meaning: null, kind });

describe("the local address", () => {
  it("accepts loopback only unless remote use is explicitly allowed", () => {
    for (const url of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
      expect(localServiceUrl(url, false).ok).toBe(true);
    }
    for (const url of ["http://192.168.1.20:11434", "https://api.ollama.example.com", "http://ollama.local:11434"]) {
      expect(localServiceUrl(url, false)).toMatchObject({ ok: false, reason: expect.stringContaining("not this computer") });
    }
    expect(localServiceUrl("http://192.168.1.20:11434", true).ok).toBe(true);
    expect(localServiceUrl("http://user:pw@127.0.0.1:11434", false).ok).toBe(false);
    expect(localServiceUrl("file:///etc/passwd", false).ok).toBe(false);
  });

  it("refuses to send anything to a remote Ollama by default", async () => {
    const result = await client("http://203.0.113.9:11434").chat({ model: "qwen2.5:7b", messages: [], schema: {}, maxOutputTokens: 10 });
    expect(result).toMatchObject({ ok: false, kind: "refused_address" });
    const extraction = await new OllamaExtractionProvider(client("http://203.0.113.9:11434"), "qwen2.5:7b", 16_384).extract(extractionRequest);
    expect(extraction.status).toBe("UNAVAILABLE");
  });
});

describe("the Ollama client", () => {
  it("lists installed models and matches a configured name with or without its tag", async () => {
    const listed = await client().models();
    expect(listed).toEqual({ ok: true, names: ["qwen2.5:7b", "llama3.1:latest"] });
    expect(modelInstalled("llama3.1", ["llama3.1:latest"])).toBe(true);
    expect(modelInstalled("qwen2.5:7b", ["qwen2.5:7b"])).toBe(true);
    expect(modelInstalled("qwen2.5:14b", ["qwen2.5:7b"])).toBe(false);
  });

  it("reports a server that is not running and a model that is not installed", async () => {
    const down = await client(`http://127.0.0.1:${await closedPort()}`).models();
    expect(down).toMatchObject({ ok: false, kind: "unreachable" });
    const missing = await client().chat({ model: "mistral", messages: [], schema: {}, maxOutputTokens: 10 });
    expect(missing).toMatchObject({ ok: false, kind: "model_missing" });
  });

  it("sends no key, asks for structured output, and keeps the model deterministic", async () => {
    await client().chat({ model: "qwen2.5:7b", messages: [{ role: "user", content: "x" }], schema: { type: "object" }, maxOutputTokens: 99 });
    const sent = ollama.requests.find((request) => request.path === "/api/chat")!;
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-api-key"]).toBeUndefined();
    expect(sent.body).toMatchObject({ stream: true, format: { type: "object" }, options: { temperature: 0, num_predict: 99 } });
  });

  it("assembles a streamed answer, so a slow answer is not cut off waiting for headers (Phase B)", async () => {
    ollama.chat = () => ({ content: '{"candidates": [], "note": "streamed in pieces"}' });
    const answer = await client().chat({ model: "qwen2.5:7b", messages: [{ role: "user", content: "x" }], schema: {}, maxOutputTokens: 10 });
    expect(answer).toEqual({
      ok: true,
      content: '{"candidates": [], "note": "streamed in pieces"}',
      model: "qwen2.5:7b",
      inputTokens: 1200,
      outputTokens: 300,
      truncated: false,
    });
  });

  it("uses nothing from a stream that errors, cannot be read or never finishes", () => {
    const piece = (content: string) => JSON.stringify({ message: { content }, done: false });
    const done = JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" });
    expect(readChatStream([piece('{"a"'), piece(":1}"), done].join("\n"), "m")).toMatchObject({ ok: true, content: '{"a":1}' });
    expect(readChatStream([piece('{"a"'), JSON.stringify({ error: "out of memory" })].join("\n"), "m")).toMatchObject({ ok: false, kind: "error" });
    // D-127: an unreadable line is a malformed answer; a stream that never says it is done is incomplete.
    expect(readChatStream([piece('{"a"'), "{not json"].join("\n"), "m")).toMatchObject({ ok: false, kind: "malformed" });
    expect(readChatStream(piece('{"a":1}'), "m")).toMatchObject({ ok: false, kind: "incomplete" });
    expect(readChatStream("", "m")).toMatchObject({ ok: false, kind: "incomplete" });
    expect(readChatStream([piece('{"a"'), JSON.stringify({ done: true, done_reason: "length" })].join("\n"), "m")).toMatchObject({ ok: true, truncated: true });
  });

  it("asks once more for a malformed answer, then fails — never a third time", async () => {
    ollama.chat = () => ({ content: "Sure! Here are the facts: {broken" });
    const result = await chatJson(client(), { model: "qwen2.5:7b", messages: [{ role: "user", content: "x" }], schema: {}, maxOutputTokens: 10 }, (raw) => raw);
    expect(result).toMatchObject({ ok: false, kind: "malformed" });
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(2);
    const retry = ollama.requests.filter((request) => request.path === "/api/chat")[1].body!;
    expect(retry.messages.at(-1)?.content).toMatch(/not valid JSON/);
  });

  it("accepts a corrected answer on the second attempt", async () => {
    let calls = 0;
    ollama.chat = () => ({ content: calls++ === 0 ? '{"wrong": true}' : '{"candidates": []}' });
    const result = await chatJson(
      client(),
      { model: "qwen2.5:7b", messages: [{ role: "user", content: "x" }], schema: {}, maxOutputTokens: 10 },
      (raw) => (Array.isArray((raw as { candidates?: unknown }).candidates) ? raw : null),
    );
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it("treats an answer cut off at the length limit as malformed", async () => {
    ollama.chat = () => ({ content: '{"candidates": []}', doneReason: "length" });
    const result = await chatJson(client(), { model: "qwen2.5:7b", messages: [], schema: {}, maxOutputTokens: 10 }, (raw) => raw);
    expect(result).toMatchObject({ ok: false, kind: "malformed" });
  });
});

describe("local product extraction", () => {
  it("reads candidates in the shared schema, and grounding still decides what survives", async () => {
    ollama.chat = () => ({
      content: JSON.stringify({
        candidates: [
          c("Gray coverage", "100%", "Ammonia-free** color delivers 100% gray coverage"),
          c("Processing time", "25 minutes", "Leave it on for 25 minutes total.", "compatibility_use"),
          // Made up: not on the page.
          c("Certification", "Dermatologist tested", "Dermatologist tested for sensitive scalps."),
          // A number the excerpt does not contain.
          c("Color duration", "up to 12 weeks", "up to 8 weeks of vibrant, salon-quality color and shine"),
          // Another shade's fact.
          c("Lift", "up to 3 levels", "Light Ash Blonde (08) lifts up to 3 levels.", "variant_fact"),
          // Malformed entries are dropped, not repaired.
          { label: "", value: "x", excerpt: "x", kind: "product_fact" },
          { label: "Odd", value: "x", excerpt: "x", kind: "not-a-kind" },
        ],
      }),
    });
    const provider = new OllamaExtractionProvider(client(), "qwen2.5:7b", 16_384);
    const result = await provider.extract(extractionRequest);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.candidates).toHaveLength(5);

    // The system prompt and schema are the shared ones; the page text is what Manifest retrieved.
    const sent = ollama.requests.find((request) => request.path === "/api/chat")!.body!;
    expect(sent.messages[0].content).toMatch(/You read one product document/);
    expect(JSON.stringify(sent.format)).toContain('"candidates"');
    expect(sent.messages[1].content).toContain("Leave it on for 25 minutes total.");

    const text = `${revlon.text}\nLight Ash Blonde (08) lifts up to 3 levels.`;
    const report = groundCandidates(result.candidates, { text, versions: { ours: ["Black"] } });
    expect(report.grounded.map((entry) => entry.pair.label)).toEqual(["Gray coverage", "Processing time"]);
    expect(report.rejected.map((entry) => entry.reason).sort()).toEqual(["excerpt_not_in_source", "other_variant", "unsupported_number"]);
    // The evidence is the page's excerpt, never the model's wording.
    for (const entry of report.grounded) expect(text).toContain(entry.pair.excerpt);
  });

  it("fails with nothing kept when the answer is malformed twice", async () => {
    ollama.chat = () => ({ content: "not json" });
    const result = await new OllamaExtractionProvider(client(), "qwen2.5:7b", 16_384).extract(extractionRequest);
    expect(result).toEqual({ status: "FAILED", message: expect.stringMatching(/not valid structured JSON/), code: "OLLAMA_MALFORMED_RESPONSE" });
  });

  it("is unavailable, not a cloud call, when Ollama is down or no model is chosen", async () => {
    const down = await new OllamaExtractionProvider(client(`http://127.0.0.1:${await closedPort()}`), "qwen2.5:7b", 16_384).extract(extractionRequest);
    expect(down.status).toBe("UNAVAILABLE");
    const none = await new OllamaExtractionProvider(client(), null, 16_384).extract(extractionRequest);
    expect(none).toMatchObject({ status: "UNAVAILABLE", message: expect.stringMatching(/OLLAMA_MODEL/) });
  });
});

describe("provider selection with no paid key", () => {
  it("selects Ollama and never Anthropic, even when an Anthropic key happens to be set", async () => {
    vi.stubEnv("PRODUCT_EXTRACTION_PROVIDER", "ollama");
    vi.stubEnv("SEO_PULSE_AI_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_BASE_URL", ollama.url);
    vi.stubEnv("OLLAMA_MODEL", "qwen2.5:7b");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-used");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/unused");
    const extraction = await import("@/lib/providers/extraction");
    expect(extraction.getProductExtractionProvider().key).toBe("ollama");
    const intelligence = await import("@/lib/seo-pulse/providers/intelligence");
    expect(intelligence.getIntelligenceProvider().id).toBe("ollama");
    expect(intelligence.describeIntelligenceProvider()).toMatchObject({ configured: true, paid: false, local: true });
  });

  it("uses the local rules generator, not a hosted model, when no local model is chosen", async () => {
    vi.stubEnv("SEO_PULSE_AI_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-used");
    const intelligence = await import("@/lib/seo-pulse/providers/intelligence");
    expect(intelligence.getIntelligenceProvider().id).toBe("rules");
  });

  it("sends no product data to DataForSEO while SeoPulse runs locally", async () => {
    vi.stubEnv("SEO_PULSE_AI_PROVIDER", "ollama");
    vi.stubEnv("SEO_PULSE_DATA_PROVIDER", "dataforseo");
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "password");
    const data = await import("@/lib/seo-pulse/providers/data");
    expect(data.getSeoDataProvider()).toBeNull();
    expect(data.describeDataProvider()).toMatchObject({ configured: false, paid: false });
  });

  it("starts with none of the paid keys set", async () => {
    vi.stubEnv("PRODUCT_RESEARCH_PROVIDER", "local");
    vi.stubEnv("PRODUCT_EXTRACTION_PROVIDER", "ollama");
    vi.stubEnv("SEO_PULSE_AI_PROVIDER", "ollama");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubEnv("DATAFORSEO_LOGIN", "");
    vi.stubEnv("DATAFORSEO_PASSWORD", "");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/unused");
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env).toMatchObject({ PRODUCT_RESEARCH_PROVIDER: "local", PRODUCT_EXTRACTION_PROVIDER: "ollama" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.BRAVE_SEARCH_API_KEY).toBeUndefined();
    const research = await import("@/lib/providers/research");
    expect(research.getProductResearchProvider().key).toBe("local");
  });
});

// ------------------------------------------------------------- SeoPulse

function knowledge(facts: { label: string; value: string }[]): GroundedKnowledge {
  return {
    ...EMPTY_GROUNDED,
    pkbProductId: "00000000-0000-4000-8000-00000000000a",
    name: "Harbor Acoustics HP-900 Headphones",
    brand: "Harbor Acoustics",
    resolutionState: "HIGH_CONFIDENCE",
    attributes: facts.map((fact, index) => ({ key: `k${index}`, label: fact.label, value: fact.value, unit: null, pkbVariantId: null, state: "VERIFIED" })),
  };
}

function pulseInput(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    knowledge: knowledge([
      { label: "Driver", value: "40 mm" },
      { label: "Connectivity", value: "Bluetooth 5.4" },
      { label: "Noise cancelling", value: "Active" },
    ]),
    title: "HP-900 Headphones",
    slug: "hp-900-headphones",
    brand: "Harbor Acoustics",
    sku: null,
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: ["Audio"],
    status: "draft",
    // SEO Pulse's own earlier wording is not established knowledge; a model must not see it.
    descriptionText: "Legendary 60-hour battery and studio-grade sound.",
    bulletFeatures: ["Legendary 60-hour battery"],
    pulseWritten: { description: true, bulletFeatures: true },
    specifications: [],
    measurements: [],
    details: {},
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
    images: [{ id: "00000000-0000-4000-8000-0000000000b1", url: "/x.jpg", altText: "", kind: "gallery" }],
    hasVideo: false,
    variants: [],
    reviews: { count: 0, average: null },
    ...overrides,
  };
}

const keyword = (value: string) => ({ keyword: value, intent: "product", relevance: "high", reason: "names the product" });

function answer(overrides: Record<string, unknown> = {}) {
  return {
    primaryKeyword: keyword("harbor acoustics hp-900 headphones"),
    secondaryKeywords: [keyword("hp-900 bluetooth headphones"), keyword("hp-900 headphones 60 hour battery")],
    longTailKeywords: [],
    synonyms: ["headset"],
    relatedTerms: ["noise cancelling headphones"],
    searchAliases: ["hp900"],
    misspellings: [],
    searchPhrases: ["hp-900 bluetooth 5.4 headphones"],
    brandVariations: [],
    seoTitle: { recommended: "Harbor Acoustics HP-900 Headphones, Bluetooth 5.4 with active noise cancelling and more words", alternatives: [], reason: "names it" },
    metaDescription: { recommended: "Harbor Acoustics HP-900 headphones with 40 mm drivers, Bluetooth 5.4 and active noise cancelling, described from verified facts.", reason: "facts" },
    h1: { recommended: "Harbor Acoustics HP-900 Headphones", reason: "plain" },
    slug: { recommended: "harbor-acoustics-hp-900-headphones", reason: "clean" },
    description: { improvements: [], suggestedHtml: "<p>The HP-900 has 40 mm drivers and Bluetooth 5.4.</p><script>alert(1)</script>" },
    tags: ["headphones", "bluetooth 5.4"],
    keyFeatures: ["40 mm drivers", "Bluetooth 5.4", "30-hour battery"],
    imageAlts: [
      { imageId: "00000000-0000-4000-8000-0000000000b1", altText: "Harbor Acoustics HP-900 headphones", title: null, needsReview: false, reason: "data" },
      { imageId: "not-an-image", altText: "made up", title: null, needsReview: false, reason: "x" },
    ],
    faqs: [{ question: "How long does the battery last?", answer: "About 30 hours.", needsManualAnswer: false, basis: "guess" }],
    categoryNotes: [],
    ...overrides,
  };
}

describe("local SeoPulse content", () => {
  it("shows the model established facts, never SeoPulse's own earlier wording or offer terms", () => {
    const view = groundedPromptInput(pulseInput({ specifications: [{ label: "Price", value: "BDT 9,999" }, { label: "Weight", value: "250 g" }] }));
    const shown = JSON.stringify(view);
    expect(shown).toContain("Bluetooth 5.4");
    expect(shown).toContain("250 g");
    expect(shown).not.toContain("60-hour");
    expect(shown).not.toContain("9,999");
    // Staff's own words are theirs to build on.
    const staffView = groundedPromptInput(pulseInput({ pulseWritten: { description: false, bulletFeatures: false } }));
    expect(staffView.staffKeyFeatures).toEqual(["Legendary 60-hour battery"]);
  });

  it("goes through sanitizeGenerated, and withholds figures the facts do not contain", async () => {
    ollama.chat = () => ({ content: JSON.stringify(answer()) });
    const provider = new OllamaIntelligenceProvider(client(), "qwen2.5:7b");
    const research = { siteSearch: null, keywordMetrics: [], serp: [] } as never;
    const result = await provider.analyzeProduct(pulseInput(), research);
    const generated = result.generated;
    expect(result.estimatedCostUsd).toBe(0);
    // sanitizeGenerated: title cut to its limit, an unknown image dropped, alt text always reviewed.
    expect(generated.seoTitle.recommended.length).toBeLessThanOrEqual(70);
    expect(generated.imageAlts.map((entry) => entry.imageId)).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
    expect(generated.imageAlts[0].needsReview).toBe(true);
    // Unsupported figures withheld; supported ones kept.
    expect(generated.keyFeatures).toEqual(["40 mm drivers", "Bluetooth 5.4"]);
    expect(generated.secondaryKeywords.map((entry) => entry.keyword)).toEqual(["hp 900 bluetooth headphones"]);
    expect(generated.faqs[0]).toMatchObject({ answer: null, needsManualAnswer: true });
    expect(generated.description.suggestedHtml).toContain("40 mm drivers");
    expect(generated.description.improvements[0]).toMatch(/withheld/);
    // The user message held the grounded view only.
    const sent = ollama.requests.find((request) => request.path === "/api/chat")!.body!;
    expect(sent.messages[1].content).not.toContain("60-hour");
  });

  it("drops an invented figure from the description rather than keeping it", () => {
    const generated = {
      ...answer(),
      description: { improvements: [], suggestedHtml: "<p>Up to 30 hours of battery.</p>" },
    };
    const input = pulseInput();
    const { generated: cleaned, withheld } = withholdUnsupportedFigures(generated as never, input, () => generated as never);
    expect(cleaned.description.suggestedHtml).toBeNull();
    expect(withheld).toContain("description");
  });

  it("does not show the model SeoPulse's own earlier search terms, only staff's (Phase B)", () => {
    // A wrong term SeoPulse wrote once was copied back by the model on every later run.
    const input = pulseInput({ seoFocusKeyword: "sunblock", tags: ["frying pan"], searchKeywords: ["sweets", "rucksack"] });
    const own = groundedPromptInput({ ...input, pulseWritten: { description: true, bulletFeatures: true, seoFocusKeyword: true, tags: true, searchKeywords: true } });
    expect(own.currentSearchTerms).toEqual({ focusKeyword: null, tags: [], searchKeywords: [] });
    const staff = groundedPromptInput({ ...input, pulseWritten: { description: true, bulletFeatures: true, seoFocusKeyword: false, tags: false, searchKeywords: false } });
    expect(staff.currentSearchTerms).toEqual({ focusKeyword: "sunblock", tags: ["frying pan"], searchKeywords: ["sweets", "rucksack"] });
  });

  it("shows the model only the site's synonym rows about this product (Phase B)", async () => {
    // qwen2.5:7b copied the whole shop's synonym table into a mouse's search terms.
    ollama.chat = () => ({ content: JSON.stringify(answer()) });
    const provider = new OllamaIntelligenceProvider(client(), "qwen2.5:7b");
    const siteSearch = {
      source: "This site's own search log",
      windowDays: 90,
      researchedAt: "2026-09-28T00:00:00.000Z",
      matchingQueries: [],
      queriesLeadingHere: [],
      correctedTypos: [],
      existingSynonyms: [
        { term: "headphones", synonyms: ["headset"] },
        { term: "sunblock", synonyms: ["sunscreen"] },
        { term: "frying pan", synonyms: ["skillet"] },
      ],
    };
    await provider.analyzeProduct(pulseInput(), { siteSearch, keywordMetrics: [], serp: [] } as never);
    const sent = ollama.requests.find((request) => request.path === "/api/chat")!.body!.messages[1].content;
    expect(sent).toContain("headset");
    expect(sent).not.toContain("sunblock");
    expect(sent).not.toContain("frying pan");
  });

  it("removes the site name the storefront appends itself from the SEO title (Phase B)", async () => {
    ollama.chat = () => ({
      content: JSON.stringify(
        answer({ seoTitle: { recommended: "Harbor Acoustics HP-900 Headphones · Manifest", alternatives: ["HP-900 Headphones | Manifest"], reason: "names it" } }),
      ),
    });
    const provider = new OllamaIntelligenceProvider(client(), "qwen2.5:7b");
    const { generated } = await provider.analyzeProduct(pulseInput(), { siteSearch: null, keywordMetrics: [], serp: [] } as never);
    expect(generated.seoTitle.recommended).toBe("Harbor Acoustics HP-900 Headphones");
    expect(generated.seoTitle.alternatives).toEqual(["HP-900 Headphones"]);
  });

  it("throws on a malformed answer so SeoPulse uses its rules instead — never a hosted model", async () => {
    ollama.chat = () => ({ content: '{"primaryKeyword": 7}' });
    const provider = new OllamaIntelligenceProvider(client(), "qwen2.5:7b");
    await expect(provider.analyzeProduct(pulseInput(), { siteSearch: null, keywordMetrics: [], serp: [] } as never)).rejects.toThrow(/not valid structured JSON/);
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(2);
  });
});
