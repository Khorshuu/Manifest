/**
 * D-127: the local-AI runtime — where a SeoPulse run executes, how a slow run
 * is told from a dead one, per-kind job recovery, the local-AI slot, and how
 * local-model failures are named.
 *
 * Fake providers, short delays and fake clocks only: nothing here waits the
 * minutes a real generation takes.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobs, seoResearchRuns, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { jobPolicies } from "@/lib/jobs/policies";
import { enqueueJob, recoverStaleJobs, runDueJobs, runLocalAiJob, type JobPolicies } from "@/lib/jobs/runner";
import { setProductExtractionProviderForTesting, UnconfiguredExtractionProvider } from "@/lib/providers/extraction";
import { workerLocalAiLane, localAiServiceGate } from "@/lib/jobs/worker";
import { getLocalServicesConfig, localAiRuntime } from "@/lib/providers/local/config";
import { clearLocalHealthCache } from "@/lib/providers/local/health";
import { chatJson, LocalAiError, localAiFailureCode, OllamaClient } from "@/lib/providers/local/ollama";
import {
  LocalAiQueueTimeoutError,
  setLocalAiQueueForTesting,
  tryAcquireLocalAiSlot,
  withLocalAiSlot,
} from "@/lib/providers/local/slot";
import { OllamaIntelligenceProvider } from "@/lib/seo-pulse/providers/ollama";
import { RulesIntelligenceProvider, setIntelligenceProviderForTesting } from "@/lib/seo-pulse/providers/intelligence";
import { INLINE_RUN_WINDOW_MS, requiresBackgroundExecution, seoRunPhase } from "@/lib/seo-pulse/runtime";
import { completeQueuedResearch, loadPulseInput, runSeoPulse } from "@/lib/seo-pulse/service";
import { closedPort, startFakeOllama, type FakeOllama } from "./helpers/fake-ollama";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let ollama: FakeOllama;
const staff: SessionUser = { id: "", email: "runtime@example.com", role: "staff_admin" };
let seq = 0;

const client = (url = ollama.url, timeoutMs = 5_000) => new OllamaClient(url, false, timeoutMs, 16_384);
const ask = (c: OllamaClient, model = "qwen2.5:7b") =>
  chatJson(c, { model, messages: [{ role: "user", content: "x" }], schema: {}, maxOutputTokens: 10 }, (raw) => raw);
const requestKey = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeAll(async () => {
  harness = await createTestDatabase();
  ollama = await startFakeOllama({ models: ["qwen2.5:7b"] });
}, 60_000);

afterAll(async () => {
  await ollama.close();
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db.insert(users).values({ email: staff.email, passwordHash: "x", role: "staff_admin" }).returning({ id: users.id });
  staff.id = row.id;
  ollama.requests.length = 0;
  ollama.maxActive = 0;
  ollama.chat = () => ({ content: '{"ok":true}' });
  // Nothing in this file reads documents; the extraction provider stays off.
  setProductExtractionProviderForTesting(new UnconfiguredExtractionProvider());
});

afterEach(() => {
  setIntelligenceProviderForTesting(undefined);
  setProductExtractionProviderForTesting(undefined);
  setLocalAiQueueForTesting(undefined);
  vi.unstubAllEnvs();
});

async function aProduct() {
  const category = await createCategory(staff, { name: `Runtime ${++seq}`, slug: `runtime-${seq}` });
  return createProduct(staff, { categoryId: category.id, title: `Plain Lamp ${seq}`, brand: "Generic Works" } as never);
}

// ------------------------------------------------------ 1. where a run runs

describe("where a SeoPulse run executes", () => {
  it("treats a local model as background work, and the rules generator as inline", () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(), "qwen2.5:7b"));
    expect(requiresBackgroundExecution()).toBe(true);
    setIntelligenceProviderForTesting(new RulesIntelligenceProvider());
    expect(requiresBackgroundExecution()).toBe(false);
  });

  it("keeps a hosted model in the background, as before", () => {
    vi.stubEnv("SEO_PULSE_AI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-used");
    expect(requiresBackgroundExecution()).toBe(true);
  });

  it("queues a local generation and returns without asking the model anything", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(), "qwen2.5:7b"));
    const product = await aProduct();
    const started = Date.now();
    const { run } = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.status).toBe("running");
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(0);
    const queued = await harness.db.select().from(jobs).where(eq(jobs.kind, "seo.research_product"));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", payload: { runId: run.id }, maxAttempts: 3 });
  });

  it("still answers at once with the rules generator", async () => {
    setIntelligenceProviderForTesting(new RulesIntelligenceProvider());
    const product = await aProduct();
    const { run } = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    expect(run.status).toBe("completed");
    expect(await harness.db.select().from(jobs).where(eq(jobs.kind, "seo.research_product"))).toHaveLength(0);
  });

  it("refuses a second generation while the first is queued, and joins it when asked", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(), "qwen2.5:7b"));
    const product = await aProduct();
    const { run } = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    await expect(runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true })).rejects.toMatchObject({ status: 409 });
    const joined = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true, joinRunning: true });
    expect(joined).toMatchObject({ reused: true, run: { id: run.id } });
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(1);
  });

  it("closes a run whose job is dead, so it no longer blocks a new one", async () => {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(), "qwen2.5:7b"));
    const product = await aProduct();
    const { run } = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    await harness.db.update(jobs).set({ status: "dead" }).where(eq(jobs.kind, "seo.research_product"));
    const second = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    expect(second.run.id).not.toBe(run.id);
    const [first] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.id));
    expect(first).toMatchObject({ status: "failed", error: expect.stringMatching(/stopped before it finished/) });
  });
});

// ------------------------------------------- 2. slow is not the same as dead

describe("telling a slow run from an abandoned one", () => {
  const minute = 60_000;
  const t0 = Date.UTC(2026, 8, 30, 12, 0, 0);
  const localPolicy = { staleAfterMinutes: Math.ceil(localAiRuntime(getLocalServicesConfig()).jobMs / minute) };

  it("does not call a local generation abandoned at three minutes, or at ten", () => {
    const run = { createdAt: new Date(t0) };
    for (const after of [3, 10]) {
      const job = { status: "running", lockedAt: new Date(t0 + after * minute - 30_000) };
      expect(seoRunPhase(run, job, localPolicy, t0 + after * minute)).toBe("generating");
    }
    // Queued behind another generation for twenty minutes is still queued.
    expect(seoRunPhase(run, { status: "queued", lockedAt: null }, localPolicy, t0 + 20 * minute)).toBe("queued");
  });

  it("calls it stalled once the job has shown no progress for its whole window, and abandoned once the job is dead", () => {
    const run = { createdAt: new Date(t0) };
    const lastProgress = new Date(t0);
    const window = localPolicy.staleAfterMinutes * minute;
    expect(seoRunPhase(run, { status: "running", lockedAt: lastProgress }, localPolicy, t0 + window - minute)).toBe("generating");
    expect(seoRunPhase(run, { status: "running", lockedAt: lastProgress }, localPolicy, t0 + window + minute)).toBe("stalled");
    expect(seoRunPhase(run, { status: "dead", lockedAt: null }, localPolicy, t0 + window + minute)).toBe("abandoned");
  });

  it("gives an inline run only the short window", () => {
    const run = { createdAt: new Date(t0) };
    expect(seoRunPhase(run, null, undefined, t0 + INLINE_RUN_WINDOW_MS - 1_000)).toBe("inline");
    expect(seoRunPhase(run, null, undefined, t0 + INLINE_RUN_WINDOW_MS + 1_000)).toBe("abandoned");
  });

  it("derives the local window from OLLAMA_TIMEOUT_MS, both attempts and the queue wait", () => {
    const runtime = localAiRuntime({ ...getLocalServicesConfig(), OLLAMA_TIMEOUT_MS: 600_000, LOCAL_AI_QUEUE_WAIT_MS: undefined });
    expect(runtime.callMs).toBe(2 * 600_000 + 5 * minute);
    expect(runtime.jobMs).toBe(2 * runtime.callMs);
    expect(runtime.concurrency).toBe(1);
  });
});

// ------------------------------------------------ 3. per-kind job recovery

describe("recovering stale jobs, kind by kind", () => {
  const now = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  async function running(kind: string, lockedMinutesAgo: number) {
    const [row] = await harness.db
      .insert(jobs)
      .values({ kind, status: "running", attempts: 1, maxAttempts: 3, lockedAt: ago(lockedMinutesAgo), lockedBy: "gone", runAt: ago(lockedMinutesAgo) })
      .returning({ id: jobs.id });
    return row.id;
  }
  const statusOf = async (id: string) => (await harness.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)))[0].status;

  it("gives the local-AI kind its long window and every other kind the default", async () => {
    vi.stubEnv("OLLAMA_TIMEOUT_MS", "600000");
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(), "qwen2.5:7b"));
    const policies = jobPolicies();
    expect(policies["seo.research_product"]).toMatchObject({ localAi: true, staleAfterMinutes: 50 });
    expect(policies["notifications.deliver"]).toBeUndefined();

    const notification = await running("notifications.deliver", 20);
    const generation = await running("seo.research_product", 20);
    expect(await recoverStaleJobs({ now, policies })).toBe(1);
    expect(await statusOf(notification)).toBe("queued");
    expect(await statusOf(generation)).toBe("running");

    // A generation that has shown nothing for longer than its window is recovered too.
    await harness.db.update(jobs).set({ lockedAt: ago(51) }).where(eq(jobs.id, generation));
    expect(await recoverStaleJobs({ now, policies })).toBe(1);
    expect(await statusOf(generation)).toBe("queued");
  });

  it("changes nothing for a set-up without a local model", async () => {
    setIntelligenceProviderForTesting(new RulesIntelligenceProvider());
    expect(jobPolicies()).toEqual({});
    const generation = await running("seo.research_product", 20);
    expect(await recoverStaleJobs({ now, policies: jobPolicies() })).toBe(1);
    expect(await statusOf(generation)).toBe("queued");
  });

  it("keeps a long job's progress current with a heartbeat, for at most its maximum", async () => {
    const policies: JobPolicies = { slow: { staleAfterMinutes: 15, heartbeat: { everyMs: 20, maxRuntimeMs: 60_000 } } };
    await enqueueJob({ kind: "slow" });
    let lockedWhileRunning: Date[] = [];
    await runDueJobs(
      {
        slow: async (_payload, context) => {
          const read = async () => (await harness.db.select({ lockedAt: jobs.lockedAt }).from(jobs).where(eq(jobs.id, context.jobId)))[0].lockedAt!;
          const first = await read();
          await new Promise((resolve) => setTimeout(resolve, 120));
          lockedWhileRunning = [first, await read()];
          return null;
        },
      },
      { policies },
    );
    expect(lockedWhileRunning[1].getTime()).toBeGreaterThan(lockedWhileRunning[0].getTime());
  });
});

// ------------------------------------------------------ 4. the local-AI slot

describe("the local-AI slot", () => {
  it("never lets two model calls run at once, and lets the second run after the first", async () => {
    ollama.chat = () => ({ content: '{"ok":true}', delayMs: 150 });
    const [first, second] = await Promise.all([ask(client()), ask(client())]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(ollama.maxActive).toBe(1);
    expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(2);
  });

  it("is released when the work throws", async () => {
    await expect(withLocalAiSlot(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const slot = await tryAcquireLocalAiSlot();
    expect(slot).not.toBeNull();
    await slot!.release();
  });

  it("is released when the model times out", async () => {
    ollama.chat = () => ({ content: '{"ok":true}', delayMs: 400 });
    const result = await ask(client(ollama.url, 100));
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    const slot = await tryAcquireLocalAiSlot();
    expect(slot).not.toBeNull();
    await slot!.release();
  });

  it("gives up waiting for a busy slot with OLLAMA_QUEUE_WAIT_TIMEOUT", async () => {
    const held = (await tryAcquireLocalAiSlot())!;
    try {
      setLocalAiQueueForTesting({ waitMs: 80, pollMs: 20 });
      await expect(withLocalAiSlot(async () => "never")).rejects.toBeInstanceOf(LocalAiQueueTimeoutError);
      const result = await ask(client());
      expect(result).toMatchObject({ ok: false, kind: "queue_timeout" });
      expect(localAiFailureCode("queue_timeout")).toBe("OLLAMA_QUEUE_WAIT_TIMEOUT");
      expect(ollama.requests.filter((request) => request.path === "/api/chat")).toHaveLength(0);
    } finally {
      await held.release();
    }
  });

  it("runs one local-AI job per lane, leaves the next queued while the slot is busy, and runs it afterwards", async () => {
    const policies: JobPolicies = { generate: { staleAfterMinutes: 50, localAi: true } };
    await enqueueJob({ kind: "generate", payload: { n: 1 } });
    await enqueueJob({ kind: "generate", payload: { n: 2 } });
    let active = 0;
    let most = 0;
    const handlers = {
      generate: async () => {
        active += 1;
        most = Math.max(most, active);
        // The model call inside the job finds the slot already held and does not queue behind itself.
        const answer = await ask(client());
        await new Promise((resolve) => setTimeout(resolve, 60));
        active -= 1;
        return answer.ok;
      },
    };
    const [a, b] = await Promise.all([runLocalAiJob(handlers, { policies }), runLocalAiJob(handlers, { policies })]);
    expect(a.ran.length + b.ran.length).toBe(1);
    expect(most).toBe(1);
    expect(await harness.db.select().from(jobs).where(eq(jobs.status, "queued"))).toHaveLength(1);

    const later = await runLocalAiJob(handlers, { policies });
    expect(later.ran).toHaveLength(1);
    expect(await harness.db.select().from(jobs).where(eq(jobs.status, "succeeded"))).toHaveLength(2);
    // Released after each job.
    const slot = await tryAcquireLocalAiSlot();
    expect(slot).not.toBeNull();
    await slot!.release();
  });

  it("never claims a local-AI job in an ordinary batch", async () => {
    const policies: JobPolicies = { generate: { staleAfterMinutes: 50, localAi: true } };
    await enqueueJob({ kind: "generate" });
    await enqueueJob({ kind: "light" });
    const report = await runDueJobs({ generate: async () => null, light: async () => null }, { policies, localAiLane: false });
    expect(report.ran.map((entry) => entry.kind)).toEqual(["light"]);
    expect((await harness.db.select().from(jobs).where(eq(jobs.kind, "generate")))[0].status).toBe("queued");
  });
});

// ------------------------------------------------- 5. naming the failures

describe("naming local-model failures", () => {
  const provider = (c: OllamaClient, model = "qwen2.5:7b") => new OllamaIntelligenceProvider(c, model);
  const research = { siteSearch: null, keywordMetrics: [], serp: [] };

  async function failure(p: OllamaIntelligenceProvider) {
    const input = (await loadPulseInput((await aProduct()).id))!;
    try {
      await p.analyzeProduct(input, research);
    } catch (error) {
      return error;
    }
    throw new Error("expected a failure");
  }

  it("says Ollama is unavailable when nothing answers", async () => {
    const error = await failure(provider(client(`http://127.0.0.1:${await closedPort()}`)));
    expect(error).toBeInstanceOf(LocalAiError);
    expect(error).toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
  });

  it("says the model is not installed", async () => {
    expect(await failure(provider(client(), "missing-model:1b"))).toMatchObject({ code: "OLLAMA_MODEL_NOT_FOUND" });
  });

  it("says the generation timed out", async () => {
    ollama.chat = () => ({ content: "{}", delayMs: 400 });
    expect(await failure(provider(client(ollama.url, 100)))).toMatchObject({ code: "OLLAMA_GENERATION_TIMEOUT" });
  });

  it("says the answer was malformed, and an unfinished stream is named apart", async () => {
    ollama.chat = () => ({ content: "not json at all" });
    expect(await failure(provider(client()))).toMatchObject({ code: "OLLAMA_MALFORMED_RESPONSE" });
    expect(localAiFailureCode("incomplete")).toBe("OLLAMA_INCOMPLETE_STREAM");
    expect(localAiFailureCode("error")).toBe("OLLAMA_PROVIDER_ERROR");
  });

  it("records a rules fallback as rules, with the code of what failed", async () => {
    setIntelligenceProviderForTesting(provider(client(`http://127.0.0.1:${await closedPort()}`)));
    const product = await aProduct();
    const { run } = await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true });
    await completeQueuedResearch(run.id);
    const [stored] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.id));
    expect(stored.status).toBe("completed");
    const analysis = stored.analysis as { generator: { kind: string; localGrounded: boolean; fallbackFrom?: { code: string } } };
    expect(analysis.generator).toMatchObject({ kind: "rules", localGrounded: false, fallbackFrom: { code: "OLLAMA_UNAVAILABLE" } });
    expect(stored.providerUsage).toContainEqual(expect.objectContaining({ id: "ollama", status: "failed", errorCode: "OLLAMA_UNAVAILABLE" }));
  });
});

// ------------------------------------- 6. a GPU that is down, for the worker

describe("the worker's lane while the model's service is down (D-134)", () => {
  /** The worker's gate, pointed at an address where nothing answers, or at the fake Ollama. */
  async function gate(url: string, waitMinutes = 30) {
    clearLocalHealthCache();
    return localAiServiceGate({ ...getLocalServicesConfig(), OLLAMA_BASE_URL: url, OLLAMA_MODEL: "qwen2.5:7b", LOCAL_AI_SERVICE_WAIT_MINUTES: waitMinutes });
  }

  async function queuedRun(url: string) {
    setIntelligenceProviderForTesting(new OllamaIntelligenceProvider(client(url), "qwen2.5:7b"));
    const product = await aProduct();
    return (await runSeoPulse(staff, product.id, { requestKey: requestKey(), fresh: true })).run;
  }

  const stored = async (runId: string) => (await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, runId)))[0];
  const job = async () => (await harness.db.select().from(jobs).where(eq(jobs.kind, "seo.research_product")))[0];

  it("leaves a fresh SeoPulse run queued instead of finishing it with rules wording", async () => {
    const down = `http://127.0.0.1:${await closedPort()}`;
    const run = await queuedRun(down);
    const service = await gate(down);

    await workerLocalAiLane({ localAiService: service });

    expect((await job()).status).toBe("queued");
    expect((await job()).attempts).toBe(0);
    expect((await stored(run.id)).status).toBe("running");
  });

  it("claims it as soon as the model's service answers, and asks the model", async () => {
    const run = await queuedRun(ollama.url);
    const service = await gate(ollama.url);

    await workerLocalAiLane({ localAiService: service });

    expect((await job()).status).toBe("succeeded");
    expect((await stored(run.id)).status).toBe("completed");
    expect(ollama.requests.filter((request) => request.path === "/api/chat").length).toBeGreaterThan(0);
  });

  it("runs it after the wait anyway, recorded as rules with the outage it fell back from", async () => {
    const down = `http://127.0.0.1:${await closedPort()}`;
    const run = await queuedRun(down);
    await harness.db.update(jobs).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(jobs.kind, "seo.research_product"));

    await workerLocalAiLane({ localAiService: await gate(down) });

    const after = await stored(run.id);
    expect(after.status).toBe("completed");
    const analysis = after.analysis as { generator: { kind: string; fallbackFrom?: { code: string } } };
    expect(analysis.generator).toMatchObject({ kind: "rules", fallbackFrom: { code: "OLLAMA_UNAVAILABLE" } });
  });

  it("does not wait at all with LOCAL_AI_SERVICE_WAIT_MINUTES=0, as before", async () => {
    const down = `http://127.0.0.1:${await closedPort()}`;
    const run = await queuedRun(down);
    await workerLocalAiLane({ localAiService: await gate(down, 0) });
    expect((await stored(run.id)).status).toBe("completed");
  });

  it("does not wait for an address that is refused: that cannot clear by itself", async () => {
    const refused = "http://gpu.example.net:11434";
    const run = await queuedRun(`http://127.0.0.1:${await closedPort()}`);
    await workerLocalAiLane({ localAiService: await gate(refused) });
    expect((await stored(run.id)).status).toBe("completed");
  });

  it("leaves ordinary jobs alone: an outage of the model never holds up the rest of the queue", async () => {
    const down = `http://127.0.0.1:${await closedPort()}`;
    await queuedRun(down);
    await enqueueJob({ kind: "light" });
    const report = await runDueJobs({ light: async () => null }, { policies: jobPolicies(), localAiLane: false });
    expect(report.ran.map((entry) => entry.kind)).toEqual(["light"]);
  });
});
