/**
 * The job runner (D-053): claiming, retry with backoff, dead-lettering,
 * recovery from a vanished worker, slot-deduplicated scheduling — and
 * notification delivery that claims each message before sending it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs, notifications, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  backoffSeconds,
  enqueueJob,
  retryDeadJob,
  runDueJobs,
  scheduleRecurringJobs,
} from "@/lib/jobs/runner";
import { JOB_HANDLERS, RECURRING_JOBS } from "@/lib/jobs/registry";
import { deliverQueuedNotifications, DELIVERY_CLAIM_MINUTES } from "@/lib/notifications";
import { setNotificationProviderForTesting, type NotificationProvider } from "@/lib/providers/notification";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: SessionUser;
let staff: SessionUser;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setNotificationProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const rows = await harness.db
    .insert(users)
    .values([
      { email: "owner@example.com", passwordHash: "x", role: "super_admin" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
    ])
    .returning({ id: users.id, email: users.email, role: users.role });
  const ownerRow = rows.find((row) => row.role === "super_admin")!;
  owner = { id: ownerRow.id, email: ownerRow.email, role: "super_admin" };
  const staffRow = rows.find((row) => row.role === "staff_admin")!;
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };
});

async function job(id: string) {
  const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

async function onlyJob() {
  const rows = await harness.db.select().from(jobs);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("enqueueing", () => {
  it("ignores a second job with the same dedupe key", async () => {
    expect(await enqueueJob({ kind: "demo", dedupeKey: "once" })).toBe(true);
    expect(await enqueueJob({ kind: "demo", dedupeKey: "once" })).toBe(false);
    expect(await enqueueJob({ kind: "demo" })).toBe(true);
    expect(await enqueueJob({ kind: "demo" })).toBe(true);
    await expect(harness.db.select().from(jobs)).resolves.toHaveLength(3);
  });

  it("schedules each recurring job once per time slot, however often it is triggered", async () => {
    const at = new Date("2026-09-15T10:00:30Z");
    expect(await scheduleRecurringJobs(RECURRING_JOBS, at)).toBe(RECURRING_JOBS.length);
    expect(await scheduleRecurringJobs(RECURRING_JOBS, new Date("2026-09-15T10:00:50Z"))).toBe(0);

    // A minute later only the every-minute job has a new slot.
    expect(await scheduleRecurringJobs(RECURRING_JOBS, new Date("2026-09-15T10:01:05Z"))).toBe(1);
  });

  it("has a handler for every recurring kind", () => {
    for (const recurring of RECURRING_JOBS) expect(JOB_HANDLERS[recurring.kind]).toBeTypeOf("function");
  });
});

describe("running", () => {
  it("runs a due job once and records its result", async () => {
    await enqueueJob({ kind: "demo", payload: { n: 2 } });
    let calls = 0;

    const report = await runDueJobs({
      demo: async (payload) => {
        calls += 1;
        return { doubled: Number(payload.n) * 2 };
      },
    });

    expect(calls).toBe(1);
    expect(report.succeeded).toBe(1);
    const row = await onlyJob();
    expect(row).toMatchObject({ status: "succeeded", attempts: 1, result: { doubled: 4 }, lastError: null });

    // Nothing left to run.
    expect((await runDueJobs({ demo: async () => (calls += 1) })).ran).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("leaves a job that is not yet due", async () => {
    await enqueueJob({ kind: "demo", runAt: new Date(Date.now() + 60_000) });
    const report = await runDueJobs({ demo: async () => null });
    expect(report.ran).toHaveLength(0);
  });

  it("requeues a failure with backoff, then dead-letters it at the attempt limit", async () => {
    await enqueueJob({ kind: "flaky", maxAttempts: 2 });
    // Anchored to the real clock: a job enqueued now defaults to run now.
    let clock = new Date(Date.now() + 1000);
    const handlers = {
      flaky: async () => {
        throw new Error("provider unavailable");
      },
    };

    const first = await runDueJobs(handlers, { now: () => clock });
    expect(first.retried).toBe(1);
    let row = await onlyJob();
    expect(row.status).toBe("queued");
    expect(row.lastError).toBe("provider unavailable");
    expect(row.runAt.getTime()).toBe(clock.getTime() + backoffSeconds(1) * 1000);

    // Not retried before its backoff has passed.
    expect((await runDueJobs(handlers, { now: () => clock })).ran).toHaveLength(0);

    clock = new Date(clock.getTime() + 31_000);
    const second = await runDueJobs(handlers, { now: () => clock });
    expect(second.dead).toBe(1);
    row = await onlyJob();
    expect(row).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("dead-letters a kind nobody handles, rather than retrying it forever", async () => {
    await enqueueJob({ kind: "unheard-of" });
    const report = await runDueJobs({});
    expect(report.dead).toBe(1);
    expect((await onlyJob()).lastError).toMatch(/No handler/);
  });

  it("returns a job whose worker vanished to the queue", async () => {
    await enqueueJob({ kind: "demo" });
    const row = await onlyJob();
    await harness.db
      .update(jobs)
      .set({ status: "running", attempts: 1, lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "gone" })
      .where(eq(jobs.id, row.id));

    const report = await runDueJobs({ demo: async () => "done" });

    expect(report.recovered).toBe(1);
    expect(await job(row.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });
});

describe("retrying a dead job", () => {
  it("is for the owner only", async () => {
    await enqueueJob({ kind: "unheard-of" });
    await runDueJobs({});
    const row = await onlyJob();

    await expect(retryDeadJob(staff, row.id)).rejects.toThrow(AuthorizationError);
    await retryDeadJob(owner, row.id);
    expect(await job(row.id)).toMatchObject({ status: "queued", attempts: 0 });
  });
});

describe("notification delivery claims each message", () => {
  const sent: string[] = [];
  const provider: NotificationProvider = {
    name: "counting",
    async send(message) {
      sent.push(message.recipient);
      return { providerMessageId: `count-${sent.length}` };
    },
  } as NotificationProvider;

  beforeEach(() => {
    sent.length = 0;
    setNotificationProviderForTesting(provider);
  });

  async function queue(recipient: string, overrides: Partial<typeof notifications.$inferInsert> = {}) {
    const [row] = await harness.db
      .insert(notifications)
      .values({
        recipient,
        channel: "email",
        template: "order.placed",
        subject: "Hello",
        body: "Body",
        dedupeKey: `test:${recipient}:${Math.random()}`,
        ...overrides,
      })
      .returning({ id: notifications.id });
    return row.id;
  }

  it("never picks up a message another run has claimed", async () => {
    await queue("claimed@example.com", { status: "sending", claimedAt: new Date() });
    await queue("waiting@example.com");

    const report = await deliverQueuedNotifications();

    expect(sent).toEqual(["waiting@example.com"]);
    expect(report.attempted).toBe(1);
  });

  it("retries a claim abandoned by a run that died", async () => {
    const id = await queue("abandoned@example.com", {
      status: "sending",
      claimedAt: new Date(Date.now() - (DELIVERY_CLAIM_MINUTES + 1) * 60_000),
    });

    await deliverQueuedNotifications();

    expect(sent).toEqual(["abandoned@example.com"]);
    const [row] = await harness.db.select().from(notifications).where(eq(notifications.id, id));
    // The abandoned attempt counts, then this one.
    expect(row).toMatchObject({ status: "sent", attempts: 2, claimedAt: null });
  });
});
