/**
 * D-133: Ollama and SearXNG as private services beside a worker rather than
 * on the developer's computer — the opt-in that keeps product documents from
 * going to an address somebody merely typed, the rule that a remote address
 * is private or encrypted, and the gateway token.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalServicesConfig, isPrivateNetworkHost, localRequest, localServiceUrl } from "@/lib/providers/local/config";
import { checkOllama, clearLocalHealthCache } from "@/lib/providers/local/health";
import { setDatabaseForTesting, type Database } from "@/db";
import { chatJson, localAiFailureCode, OllamaClient } from "@/lib/providers/local/ollama";
import { LocalAiSlotConnectionError, slotConnectionProblem, tryAcquireLocalAiSlot } from "@/lib/providers/local/slot";
import { searchSearxng } from "@/lib/providers/research/searxng";
import { startFakeOllama, type FakeOllama } from "./helpers/fake-ollama";

const TOKEN = "gateway-token-0123456789";

/** A gateway in front of a service: 401 without the right bearer token. */
type Gateway = { url: string; seen: (string | undefined)[]; close(): Promise<void> };
async function startGateway(answer: (path: string) => { status: number; body: string }): Promise<Gateway> {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    const reply = answer(request.url ?? "");
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("which addresses a service may have", () => {
  it("is loopback only until remote use is explicitly allowed", () => {
    for (const url of ["http://10.0.0.5:11434", "http://ollama.internal:11434", "https://ai.example.com"]) {
      expect(localServiceUrl(url, false)).toMatchObject({ ok: false, reason: expect.stringContaining("not this computer") });
    }
    expect(localServiceUrl("http://127.0.0.1:11434", false)).toMatchObject({ ok: true, remote: false });
  });

  it("changing the address alone never sends anything remote: the flag defaults to off", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "https://ai.example.com");
    vi.stubEnv("SEARXNG_BASE_URL", "https://search.example.com");
    const config = getLocalServicesConfig();
    expect(config.OLLAMA_ALLOW_REMOTE).toBe(false);
    expect(config.SEARXNG_ALLOW_REMOTE).toBe(false);
    expect(localServiceUrl(config.OLLAMA_BASE_URL, config.OLLAMA_ALLOW_REMOTE).ok).toBe(false);
  });

  it("accepts a remote address on a private network over plain http", () => {
    for (const url of [
      "http://10.0.0.5:11434",
      "http://172.20.3.4:11434",
      "http://192.168.1.20:11434",
      "http://100.101.102.103:11434", // an overlay network's range
      "http://[fd12:3456:789a::1]:11434",
      "http://ollama:11434", // a service name on a container network
      "http://ollama.internal:11434",
      "http://gpu-1.staging.internal:11434",
    ]) {
      expect(localServiceUrl(url, true), url).toMatchObject({ ok: true, remote: true });
    }
  });

  it("refuses a remote address on the public internet unless it is https", () => {
    for (const url of ["http://ai.example.com:11434", "http://203.0.113.9:11434", "http://172.32.0.1:11434", "http://[2001:4860::1]:11434"]) {
      expect(localServiceUrl(url, true), url).toMatchObject({ ok: false, reason: expect.stringContaining("must be reached over https") });
    }
    expect(localServiceUrl("https://ai.example.com", true)).toMatchObject({ ok: true, remote: true });
  });

  it("still refuses credentials in the address and anything but http(s), remote or not", () => {
    expect(localServiceUrl("https://user:pw@ai.example.com", true).ok).toBe(false);
    expect(localServiceUrl("ftp://10.0.0.5", true).ok).toBe(false);
  });

  it("judges a private host by its name, not by what it sounds like", () => {
    expect(isPrivateNetworkHost("internal.example.com")).toBe(false);
    expect(isPrivateNetworkHost("example.internal.com")).toBe(false);
    expect(isPrivateNetworkHost("10.0.0.5.example.com")).toBe(false);
    expect(isPrivateNetworkHost("172.15.0.1")).toBe(false);
    expect(isPrivateNetworkHost("OLLAMA.INTERNAL")).toBe(true);
    expect(isPrivateNetworkHost("[fd00::1]")).toBe(true);
  });

  it("accepts a gateway token of a real length only", () => {
    vi.stubEnv("OLLAMA_AUTH_TOKEN", "short");
    expect(() => getLocalServicesConfig()).toThrow(/OLLAMA_AUTH_TOKEN/);
  });
});

describe("a service behind a gateway", () => {
  let gateway: Gateway;
  beforeAll(async () => {
    gateway = await startGateway((path) =>
      path.startsWith("/api/tags")
        ? { status: 200, body: JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }) }
        : path.startsWith("/search")
          ? { status: 200, body: JSON.stringify({ results: [{ url: "https://brand.example/p/1", title: "Product", content: "about it" }] }) }
          : { status: 404, body: "{}" },
    );
  });
  afterAll(() => gateway.close());
  beforeEach(() => {
    gateway.seen.length = 0;
    clearLocalHealthCache();
  });

  it("is sent the token as a bearer header, and no token when none is set", async () => {
    const withToken = await localRequest(new URL(`${gateway.url}/api/tags`), { timeoutMs: 2_000, maxBytes: 10_000, token: TOKEN });
    expect(withToken).toMatchObject({ ok: true, status: 200 });
    const without = await localRequest(new URL(`${gateway.url}/api/tags`), { timeoutMs: 2_000, maxBytes: 10_000 });
    expect(without).toMatchObject({ ok: true, status: 401 });
    expect(gateway.seen).toEqual([`Bearer ${TOKEN}`, undefined]);
  });

  it("lists Ollama's models through it", async () => {
    const client = new OllamaClient(gateway.url, false, 5_000, 4_096, TOKEN);
    expect(await client.models()).toEqual({ ok: true, names: ["qwen2.5:7b"] });
  });

  it("reports a refused token as Ollama being unavailable, never as an answer", async () => {
    const client = new OllamaClient(gateway.url, false, 5_000, 4_096, "the-wrong-token-0123456789");
    const listed = await client.models();
    expect(listed).toMatchObject({ ok: false, kind: "unreachable" });
    const chat = await client.chat({ model: "qwen2.5:7b", messages: [{ role: "user", content: "hello" }], schema: {}, maxOutputTokens: 10 });
    expect(chat).toMatchObject({ ok: false, kind: "unreachable" });
    // The D-127 classification a job, a retry and the status screen all read.
    if (!chat.ok) expect(localAiFailureCode(chat.kind)).toBe("OLLAMA_UNAVAILABLE");
    if (!listed.ok) expect(listed.message).not.toContain("the-wrong-token");
  });

  it("health says unavailable when the gateway refuses, and ready when it accepts", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", gateway.url);
    expect(await checkOllama("qwen2.5:7b", getLocalServicesConfig())).toMatchObject({ state: "unavailable" });
    clearLocalHealthCache();
    vi.stubEnv("OLLAMA_AUTH_TOKEN", TOKEN);
    const ready = await checkOllama("qwen2.5:7b", getLocalServicesConfig());
    expect(ready).toMatchObject({ state: "ready" });
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
  });

  it("searches SearXNG through it, with the same bounds and English-only request", async () => {
    const found = await searchSearxng(gateway.url, false, "brand product 123", 5, { token: TOKEN });
    expect(found).toMatchObject({ status: "OK", candidates: [{ url: "https://brand.example/p/1" }] });
    const refused = await searchSearxng(gateway.url, false, "brand product 123", 5);
    expect(refused).toMatchObject({ status: "UNAVAILABLE", message: expect.stringContaining("SEARXNG_AUTH_TOKEN") });
  });

  it("refuses a remote SearXNG that was not opted in to, before any request", async () => {
    gateway.seen.length = 0;
    expect(await searchSearxng("https://search.example.com", false, "q", 5, { token: TOKEN })).toMatchObject({ status: "REFUSED_ADDRESS" });
    expect(await searchSearxng("http://search.example.com", true, "q", 5, { token: TOKEN })).toMatchObject({ status: "REFUSED_ADDRESS" });
    expect(gateway.seen).toHaveLength(0);
  });
});

describe("Ollama without a gateway", () => {
  let ollama: FakeOllama;
  beforeAll(async () => {
    ollama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  });
  afterAll(() => ollama.close());

  it("is sent no authorization header at all", async () => {
    await OllamaClient.fromConfig({ ...getLocalServicesConfig(), OLLAMA_BASE_URL: ollama.url }).models();
    expect(ollama.requests.at(-1)?.headers.authorization).toBeUndefined();
  });
});

describe("the local-AI slot's connection", () => {
  it("is trusted over a direct address and refused over a pooled one", () => {
    expect(slotConnectionProblem("postgres://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/manifest_staging")).toBeNull();
    expect(slotConnectionProblem("postgres://postgres:postgres@127.0.0.1:5432/preorder")).toBeNull();
    const problem = slotConnectionProblem("postgres://u:p@ep-cool-name-123-pooler.eu-central-1.aws.neon.tech/manifest_staging");
    expect(problem).toBeInstanceOf(LocalAiSlotConnectionError);
    expect(problem?.code).toBe("LOCAL_AI_SLOT_NEEDS_DIRECT_CONNECTION");
    // The message names the fix and nothing from the address.
    expect(problem?.message).toMatch(/direct/);
    expect(problem?.message).not.toMatch(/neon|ep-cool/);
  });

  it("makes the model unavailable, not a crash, to a process on a pooled address", async () => {
    let reserved = 0;
    // A postgres-js client, as far as the slot looks: it would reserve a connection.
    setDatabaseForTesting({ $client: { reserve: async () => void (reserved += 1) } } as unknown as Database);
    vi.stubEnv("DATABASE_URL", "postgres://u:p@ep-cool-name-123-pooler.eu-central-1.aws.neon.tech/manifest_staging");
    try {
      await expect(tryAcquireLocalAiSlot(1)).rejects.toBeInstanceOf(LocalAiSlotConnectionError);
      const answer = await chatJson(
        new OllamaClient("http://127.0.0.1:9", false, 1_000, 4_096),
        { model: "qwen2.5:7b", messages: [{ role: "user", content: "hello" }], schema: {}, maxOutputTokens: 10 },
        (raw) => raw,
      );
      expect(answer).toMatchObject({ ok: false, kind: "unreachable" });
      if (!answer.ok) expect(localAiFailureCode(answer.kind)).toBe("OLLAMA_UNAVAILABLE");
      // The lock was never attempted over the pooler.
      expect(reserved).toBe(0);
      // And the slot is free again for a process that can hold it.
      vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/preorder");
      await expect(tryAcquireLocalAiSlot(1)).rejects.not.toBeInstanceOf(LocalAiSlotConnectionError);
    } finally {
      setDatabaseForTesting(undefined);
    }
  });

  it("keeps one generation at a time by default, whatever the hardware", () => {
    expect(getLocalServicesConfig().LOCAL_AI_CONCURRENCY).toBe(1);
  });
});
