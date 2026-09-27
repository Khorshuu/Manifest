/**
 * D-124: bounded health checks for the local services, the owner's setup
 * panel built from them, and which linked pages count as "the same product".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { relatedPageLinks } from "@/lib/pkb/related-pages";
import { getLocalServicesConfig } from "@/lib/providers/local/config";
import { checkBrowser, checkOllama, checkSearxng, clearLocalHealthCache } from "@/lib/providers/local/health";
import { closedPort, startFakeOllama, type FakeOllama } from "./helpers/fake-ollama";

let ollama: FakeOllama;
let searx: http.Server;
let searxUrl = "";
let jsonEnabled = true;

beforeAll(async () => {
  ollama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  searx = http.createServer((_request, response) => {
    response.writeHead(jsonEnabled ? 200 : 403, { "content-type": jsonEnabled ? "application/json" : "text/html" });
    response.end(jsonEnabled ? '{"results":[]}' : "Forbidden");
  });
  await new Promise<void>((resolve) => searx.listen(0, "127.0.0.1", resolve));
  searxUrl = `http://127.0.0.1:${(searx.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await ollama.close();
  await new Promise((resolve) => searx.close(resolve));
});
beforeEach(() => clearLocalHealthCache());
afterEach(() => vi.unstubAllEnvs());

const config = (overrides: Record<string, string>) => {
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  return getLocalServicesConfig();
};

describe("Ollama health", () => {
  it("tells a stopped server, a missing model and a ready model apart", async () => {
    expect(await checkOllama("qwen2.5:7b", config({ OLLAMA_BASE_URL: ollama.url }))).toMatchObject({ state: "ready" });
    clearLocalHealthCache();
    expect(await checkOllama("llama3.1:8b", config({ OLLAMA_BASE_URL: ollama.url }))).toMatchObject({ state: "model_missing", message: expect.stringContaining("ollama pull llama3.1:8b") });
    clearLocalHealthCache();
    expect(await checkOllama("qwen2.5:7b", config({ OLLAMA_BASE_URL: `http://127.0.0.1:${await closedPort()}` }))).toMatchObject({ state: "unavailable" });
    expect(await checkOllama(null, config({}))).toMatchObject({ state: "no_model" });
    expect(await checkOllama("qwen2.5:7b", config({ OLLAMA_BASE_URL: "http://10.0.0.5:11434" }))).toMatchObject({ state: "refused_address" });
  });

  it("asks once, then answers from its short cache", async () => {
    const settings = config({ OLLAMA_BASE_URL: ollama.url });
    ollama.requests.length = 0;
    await checkOllama("qwen2.5:7b", settings);
    await checkOllama("qwen2.5:7b", settings);
    await checkOllama("qwen2.5:7b", settings);
    expect(ollama.requests.filter((request) => request.path === "/api/tags")).toHaveLength(1);
  });
});

describe("SearXNG health", () => {
  it("tells unavailable, JSON disabled and ready apart", async () => {
    expect(await checkSearxng(config({}))).toMatchObject({ state: "not_configured" });
    expect(await checkSearxng(config({ SEARXNG_BASE_URL: searxUrl }))).toMatchObject({ state: "ready" });
    clearLocalHealthCache();
    jsonEnabled = false;
    expect(await checkSearxng(config({ SEARXNG_BASE_URL: searxUrl }))).toMatchObject({ state: "json_disabled" });
    jsonEnabled = true;
    clearLocalHealthCache();
    expect(await checkSearxng(config({ SEARXNG_BASE_URL: `http://127.0.0.1:${await closedPort()}` }))).toMatchObject({ state: "unavailable" });
  });
});

describe("browser renderer health", () => {
  it("is off unless chosen, and otherwise reports the runtime and the browser binary", async () => {
    expect(await checkBrowser(config({}))).toMatchObject({ state: "not_configured" });
    const state = (await checkBrowser(config({ LOCAL_BROWSER_RENDERER: "playwright" }))).state;
    expect(["ready", "browser_missing", "runtime_missing"]).toContain(state);
  });
});

describe("the owner's setup panel", () => {
  it("shows local states with no secret, and works with every local service stopped", async () => {
    const stopped = `http://127.0.0.1:${await closedPort()}`;
    config({
      SESSION_SECRET: "s".repeat(32),
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/unused",
      PRODUCT_RESEARCH_PROVIDER: "local",
      PRODUCT_EXTRACTION_PROVIDER: "ollama",
      SEO_PULSE_AI_PROVIDER: "ollama",
      OLLAMA_BASE_URL: stopped,
      OLLAMA_MODEL: "qwen2.5:7b",
      SEARXNG_BASE_URL: stopped,
      LOCAL_BROWSER_RENDERER: "none",
      ANTHROPIC_API_KEY: "sk-ant-should-never-be-shown",
    });
    vi.resetModules();
    const { researchSetup } = await import("@/lib/preparation/setup");
    const items = await researchSetup();
    expect(items.map((item) => [item.key, item.status])).toEqual([
      ["discovery", "SearXNG not running"],
      ["extraction", "Ollama not running"],
      ["content", "Ollama not running"],
      ["crawler", "Static fetch ready · browser renderer off"],
    ]);
    expect(JSON.stringify(items)).not.toContain("sk-ant");
    expect(items.find((item) => item.key === "discovery")?.detail).toMatch(/official-domain and sitemap discovery only/);
  });
});

describe("related pages of the same product", () => {
  const page = "https://www.sonoline.test/en/wh-4000-wireless-headphones";
  const html = `
    <a href="/en/support">Support</a>
    <a href="/en/support/wh-4000/specifications">Technical specifications</a>
    <a href="/en/support/wh-4000/manual">User manual</a>
    <a href="/en/wh-4000/reviews">Reviews</a>
    <a href="/en/blog/wh-4000-specs">Blog: specs explained</a>
    <a href="/en/support/wh-3000/specifications">WH-3000 specifications</a>
    <a href="https://other.test/wh-4000/specifications">Elsewhere</a>
    <a href="/en/wh-4000/manual.pdf">PDF manual</a>
    <a href="/en/cart?add=wh-4000">Add to cart</a>
    <a href="/en/support/wh-4000/faq">FAQ</a>`;

  it("follows the product's own specification and support pages, at most three", () => {
    const links = relatedPageLinks(html, page, ["Sonoline WH-4000 Wireless Headphones", "WH-4000"]);
    expect(links.map((link) => link.url)).toEqual([
      "https://www.sonoline.test/en/support/wh-4000/specifications",
      "https://www.sonoline.test/en/support/wh-4000/manual",
      "https://www.sonoline.test/en/support/wh-4000/faq",
    ]);
  });

  it("follows nothing from a page with no product-tied links", () => {
    expect(relatedPageLinks(`<a href="/support">Support</a><a href="/specifications">Specifications</a>`, "https://shop.test/products/aurel-serum", ["Aurel Serum"])).toEqual([]);
  });
});
