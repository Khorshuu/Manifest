/**
 * D-133: the background worker — the job trigger as a process of its own —
 * and what the web application does when a worker runs the jobs: its own
 * trigger declines, cache invalidations are handed over, and health and the
 * setup panel report what the worker can reach.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobs, notifications, schedulerHeartbeats } from "@/db/schema";
import { CACHE_TAGS, invalidateCatalog, isKnownCacheTag } from "@/lib/cache";
import { systemHealth } from "@/lib/health";
import { jobRunnerMode, setWorkerProcessForTesting, WORKER_HEARTBEAT } from "@/lib/jobs/mode";
import { enqueueJob, type JobHandlers } from "@/lib/jobs/runner";
import { JOB_TRIGGER, recordSchedulerRun } from "@/lib/jobs/schedule";
import { runWorker, startCacheForwarding, workerTick } from "@/lib/jobs/worker";
import { MAX_DELIVERY_ATTEMPTS } from "@/lib/notifications";
import { researchSetup } from "@/lib/preparation/setup";
import { clearLocalHealthCache } from "@/lib/providers/local/health";
import { MockNotificationProvider, setNotificationProviderForTesting } from "@/lib/providers/notification";
import { createTestDatabase } from "./helpers/database";

const authorization = { value: "Bearer test-cron-secret" as string | null };
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "authorization" ? authorization.value : null) }),
}));

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/worker_test");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-of-at-least-32-characters");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  setNotificationProviderForTesting(undefined);
  vi.unstubAllEnvs();
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  authorization.value = "Bearer test-cron-secret";
  setNotificationProviderForTesting(new MockNotificationProvider());
  setWorkerProcessForTesting(false);
  clearLocalHealthCache();
  vi.stubEnv("JOB_RUNNER", "");
});

afterEach(() => {
  setWorkerProcessForTesting(false);
});

const NO_POLICIES = () => ({});

describe("the job runner's mode", () => {
  it("is the scheduler unless the environment says worker", () => {
    expect(jobRunnerMode(undefined)).toBe("scheduler");
    expect(jobRunnerMode("")).toBe("scheduler");
    expect(jobRunnerMode("anything")).toBe("scheduler");
    expect(jobRunnerMode(" Worker ")).toBe("worker");
  });
});

describe("one worker tick", () => {
  it("schedules recurring work, runs what is due and records the scheduler heartbeat", async () => {
    const ran: string[] = [];
    const handlers: JobHandlers = {
      "test.recurring": async () => {
        ran.push("recurring");
        return { done: true };
      },
      "test.once": async (payload) => {
        ran.push(`once:${payload.value}`);
      },
    };
    await enqueueJob({ kind: "test.once", payload: { value: 7 } });

    const summary = await workerTick({ handlers, recurring: [{ kind: "test.recurring", everyMinutes: 1 }], policies: NO_POLICIES, budgetMs: 5_000 });

    expect(summary).toMatchObject({ scheduled: 1, succeeded: 2, retried: 0, dead: 0 });
    expect(ran.sort()).toEqual(["once:7", "recurring"]);
    const [beat] = await harness.db.select().from(schedulerHeartbeats).where(eq(schedulerHeartbeats.name, JOB_TRIGGER));
    expect(beat.lastReport).toMatchObject({ runner: "worker", succeeded: 2 });
  });

  it("is idempotent within a time slot: a second tick schedules nothing new", async () => {
    let runs = 0;
    const options = {
      handlers: { "test.recurring": async () => void (runs += 1) } satisfies JobHandlers,
      recurring: [{ kind: "test.recurring", everyMinutes: 60 }],
      policies: NO_POLICIES,
      budgetMs: 5_000,
    };
    const first = await workerTick(options);
    const second = await workerTick(options);
    expect(first.scheduled).toBe(1);
    expect(second.scheduled).toBe(0);
    expect(runs).toBe(1);
  });

  it("retries a failing job with backoff instead of losing it, exactly as the trigger does", async () => {
    await enqueueJob({ kind: "test.fails" });
    const summary = await workerTick({
      handlers: {
        "test.fails": async () => {
          throw new Error("the provider is down");
        },
      },
      recurring: [],
      policies: NO_POLICIES,
      budgetMs: 2_000,
    });
    expect(summary).toMatchObject({ succeeded: 0, retried: 1, dead: 0 });
    const [row] = await harness.db.select().from(jobs);
    expect(row.status).toBe("queued");
    expect(row.lastError).toContain("the provider is down");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("delivers the notification outbox through the real handler", async () => {
    const provider = new MockNotificationProvider();
    setNotificationProviderForTesting(provider);
    await harness.db.insert(notifications).values({
      recipient: "nadia@example.com",
      channel: "email",
      template: "order.placed",
      subject: "Your order",
      body: "Thank you.",
      dedupeKey: "worker-test:1",
    });
    const { JOB_HANDLERS } = await import("@/lib/jobs/registry");

    await workerTick({ handlers: JOB_HANDLERS, recurring: [{ kind: "notifications.deliver", everyMinutes: 1 }], policies: NO_POLICIES, budgetMs: 5_000 });

    expect(provider.sent).toHaveLength(1);
    const [row] = await harness.db.select().from(notifications);
    expect(row.status).toBe("sent");
  });
});

describe("the worker loop", () => {
  it("ticks on its interval until stopped, and waits for work in hand", async () => {
    const controller = new AbortController();
    let ticksSeen = 0;
    const handlers: JobHandlers = { "test.recurring": async () => undefined };
    const result = await runWorker({
      handlers,
      recurring: [{ kind: "test.recurring", everyMinutes: 1 }],
      policies: NO_POLICIES,
      budgetMs: 1_000,
      intervalMs: 5,
      maxConcurrentTicks: 2,
      shutdownGraceMs: 5_000,
      signal: controller.signal,
      sleep: async () => {
        ticksSeen += 1;
        if (ticksSeen >= 3) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    expect(result.ticks).toBeGreaterThanOrEqual(1);
    expect(result.ticks + result.skipped).toBe(3);
    // The heartbeat is there, so the admin's "scheduled jobs are not running" warning stays quiet.
    const [beat] = await harness.db.select().from(schedulerHeartbeats).where(eq(schedulerHeartbeats.name, JOB_TRIGGER));
    expect(beat).toBeDefined();
  });

  it("keeps ticking while one tick is held by a slow job, up to its ceiling", async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await enqueueJob({ kind: "test.slow" });
    let loops = 0;
    const result = await runWorker({
      handlers: { "test.slow": () => held },
      recurring: [],
      policies: NO_POLICIES,
      budgetMs: 200,
      intervalMs: 5,
      maxConcurrentTicks: 2,
      shutdownGraceMs: 5_000,
      signal: controller.signal,
      sleep: async () => {
        loops += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (loops >= 4) {
          controller.abort();
          release();
        }
      },
    });
    // The slow job held one tick; others still ran beside it, and none above the ceiling.
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    expect(result.ticks + result.skipped).toBe(4);
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.kind, "test.slow"));
    expect(row.status).toBe("succeeded");
  });

  it("survives a tick that throws", async () => {
    const controller = new AbortController();
    let loops = 0;
    const result = await runWorker({
      handlers: {},
      recurring: [],
      policies: () => {
        throw new Error("misconfigured");
      },
      intervalMs: 5,
      maxConcurrentTicks: 1,
      shutdownGraceMs: 1_000,
      signal: controller.signal,
      sleep: async () => {
        loops += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (loops >= 2) controller.abort();
      },
    });
    expect(result.ticks).toBeGreaterThanOrEqual(1);
  });
});

describe("the web application's trigger, where a worker runs the jobs", () => {
  it("declines without claiming anything", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    await enqueueJob({ kind: "maintenance.prune" });
    const { POST } = await import("@/app/api/cron/jobs/route");

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: true });
    const [row] = await harness.db.select().from(jobs);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(await harness.db.select().from(schedulerHeartbeats)).toHaveLength(0);
  });

  it("still refuses a caller without the secret before saying anything", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    authorization.value = "Bearer wrong";
    const { POST } = await import("@/app/api/cron/jobs/route");
    expect((await POST()).status).toBe(401);
  });
});

describe("handing cache invalidations to the web application", () => {
  it("knows its own tags and nothing else", () => {
    expect(isKnownCacheTag(CACHE_TAGS.listing)).toBe(true);
    expect(isKnownCacheTag(CACHE_TAGS.product("3f2b8c1e-9a4d-4c6b-8e21-5d7f0a1b2c3d"))).toBe(true);
    for (const bad of ["", "product:1", "product:../../x", "anything", 7, null, "catalog:listing "]) {
      expect(isKnownCacheTag(bad), String(bad)).toBe(false);
    }
  });

  it("collects what jobs invalidate and posts it once, authenticated", async () => {
    const calls: { url: string; headers: Record<string, string>; body: { tags: string[] } }[] = [];
    const forwarding = startCacheForwarding({
      webUrl: "https://staging.example.com",
      cronSecret: "test-cron-secret",
      bypassSecret: "bypass",
      fetcher: (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      invalidateCatalog([CACHE_TAGS.listing, CACHE_TAGS.homepage]);
      invalidateCatalog([CACHE_TAGS.listing]);
      expect(await forwarding.flush()).toBe(2);
      expect(await forwarding.flush()).toBe(0);
    } finally {
      forwarding.stop();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://staging.example.com/api/cron/revalidate");
    expect(calls[0].headers.authorization).toBe("Bearer test-cron-secret");
    expect(calls[0].headers["x-vercel-protection-bypass"]).toBe("bypass");
    expect(calls[0].body.tags.sort()).toEqual([CACHE_TAGS.listing, CACHE_TAGS.homepage].sort());
  });

  it("keeps the tags when the web application cannot be reached, and sends them next time", async () => {
    let up = false;
    const sent: string[][] = [];
    const forwarding = startCacheForwarding({
      webUrl: "https://staging.example.com",
      cronSecret: "test-cron-secret",
      fetcher: (async (_url: URL, init: RequestInit) => {
        if (!up) throw new Error("connect ECONNREFUSED");
        sent.push(JSON.parse(String(init.body)).tags);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      invalidateCatalog([CACHE_TAGS.categories]);
      expect(await forwarding.flush()).toBe(0);
      up = true;
      expect(await forwarding.flush()).toBe(1);
    } finally {
      forwarding.stop();
    }
    expect(sent).toEqual([[CACHE_TAGS.categories]]);
  });

  it("the receiving route accepts known tags from the scheduler's secret only", async () => {
    const { POST } = await import("@/app/api/cron/revalidate/route");
    const request = (body: unknown) => new Request("https://staging.example.com/api/cron/revalidate", { method: "POST", body: JSON.stringify(body) });

    expect((await POST(request({ tags: [CACHE_TAGS.listing] }))).status).toBe(200);
    expect((await POST(request({ tags: ["something-else"] }))).status).toBe(400);
    expect((await POST(request({ tags: [] }))).status).toBe(400);
    expect((await POST(request({ tags: [CACHE_TAGS.listing], extra: true }))).status).toBe(400);

    authorization.value = null;
    expect((await POST(request({ tags: [CACHE_TAGS.listing] }))).status).toBe(401);
  });
});

describe("system health", () => {
  it("reports a quiet, working environment as ok, and names the mock providers", async () => {
    await recordSchedulerRun(JOB_TRIGGER, {});
    const health = await systemHealth();
    expect(health.database.state).toBe("ok");
    expect(health.jobs).toMatchObject({ runner: "scheduler", schedulerStale: false, queued: 0, dead: 0, stale: 0 });
    expect(health.worker.state).toBe("not_used");
    expect(health.notifications.provider.state).toBe("mock");
    expect(health.payment.provider).toBe("mock");
    expect(health.shipping.provider).toBe("mock");
    expect(health.status).toBe("ok");
    expect(health.problems).toEqual([]);
  });

  it("is degraded, with the reason, when nothing is draining the queue", async () => {
    const health = await systemHealth();
    expect(health.status).toBe("degraded");
    expect(health.jobs.schedulerStale).toBe(true);
    expect(health.problems.join(" ")).toMatch(/scheduler has not called/);
  });

  it("counts waiting, stale and dead jobs, and messages that failed for good", async () => {
    await recordSchedulerRun(JOB_TRIGGER, {});
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    await harness.db.insert(jobs).values([
      { kind: "a.due", status: "queued", runAt: new Date(Date.now() - 20 * 60_000) },
      { kind: "a.later", status: "queued", runAt: new Date(Date.now() + 60 * 60_000) },
      { kind: "a.stuck", status: "running", lockedAt: longAgo, lockedBy: "gone" },
      { kind: "a.dead", status: "dead" },
    ]);
    await harness.db.insert(notifications).values([
      { recipient: "a@example.com", channel: "email", template: "t", subject: "s", body: "b", dedupeKey: "h:1", status: "failed", attempts: MAX_DELIVERY_ATTEMPTS },
      { recipient: "b@example.com", channel: "email", template: "t", subject: "s", body: "b", dedupeKey: "h:2", status: "failed", attempts: 1 },
      { recipient: "c@example.com", channel: "email", template: "t", subject: "s", body: "b", dedupeKey: "h:3", createdAt: longAgo },
    ]);

    const health = await systemHealth();

    expect(health.jobs).toMatchObject({ queued: 2, due: 1, running: 1, stale: 1, dead: 1 });
    expect(health.jobs.oldestDueMinutes).toBeGreaterThanOrEqual(19);
    expect(health.notifications).toMatchObject({ queued: 1, retrying: 1, failed: 1 });
    expect(health.status).toBe("degraded");
    expect(health.problems.length).toBeGreaterThanOrEqual(4);
  });

  it("never carries an address, a secret or a recipient", async () => {
    vi.stubEnv("OLLAMA_AUTH_TOKEN", "gateway-token-0123456789");
    vi.stubEnv("SMTP_PASSWORD", "s3cr3t-smtp-password");
    await harness.db.insert(notifications).values({ recipient: "private@example.com", channel: "email", template: "t", subject: "s", body: "b", dedupeKey: "h:4" });
    const text = JSON.stringify(await systemHealth());
    for (const secret of ["worker_test", "postgres://", "127.0.0.1", "gateway-token", "s3cr3t", "test-cron-secret", "private@example.com", "a-session-secret"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("says the worker is silent when it runs the jobs and has not reported", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    const health = await systemHealth();
    expect(health.jobs.runner).toBe("worker");
    expect(health.worker.state).toBe("silent");
    expect(health.problems.join(" ")).toMatch(/worker is not reporting/);
  });
});

describe("the setup panel, where a worker runs the jobs", () => {
  const services = [
    { key: "discovery", label: "Local web discovery", state: "configured", status: "Ready", detail: "Finds pages." },
    { key: "extraction", label: "Local intelligent extraction", state: "configured", status: "Ollama ready — qwen2.5:7b", detail: "Reads prose." },
    { key: "content", label: "SeoPulse content AI", state: "unavailable", status: "Ollama not reachable", detail: "Waiting." },
    { key: "crawler", label: "Crawler", state: "configured", status: "Static fetch ready · browser renderer ready", detail: "Renders." },
  ];

  it("shows what the worker reported instead of asking services the web application cannot reach", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    await recordSchedulerRun(WORKER_HEARTBEAT, { services });
    const items = await researchSetup();
    expect(items.map((item) => [item.key, item.state, item.status])).toEqual(services.map((item) => [item.key, item.state, item.status]));
  });

  it("says the worker is not reporting when it never has, or has gone quiet", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    expect((await researchSetup()).every((item) => item.state === "unavailable" && item.status === "Worker not reporting")).toBe(true);

    await recordSchedulerRun(WORKER_HEARTBEAT, { services }, new Date(Date.now() - 30 * 60_000));
    expect((await researchSetup()).every((item) => item.status === "Worker not reporting")).toBe(true);
  });

  it("ignores a report it cannot read rather than showing it", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    await recordSchedulerRun(WORKER_HEARTBEAT, { services: [{ key: "discovery", state: "<script>", status: "x" }, "nonsense"] });
    const items = await researchSetup();
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.state === "unavailable")).toBe(true);
  });

  it("the worker itself asks the services directly", async () => {
    vi.stubEnv("JOB_RUNNER", "worker");
    setWorkerProcessForTesting(true);
    const items = await researchSetup();
    // Nothing is configured in the suite, so it reports that — not "Worker not reporting".
    expect(items.some((item) => item.status === "Worker not reporting")).toBe(false);
  });
});
