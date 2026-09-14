/**
 * The job runner and notification delivery under real concurrency: several
 * workers draining at once must run each job once and send each message once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, notifications } from "@/db/schema";
import { enqueueJob, runDueJobs } from "@/lib/jobs/runner";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { setNotificationProviderForTesting, type NotificationProvider } from "@/lib/providers/notification";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("jobs_concurrency_test");
}, 180_000);

afterAll(async () => {
  if (!available) return;
  setNotificationProviderForTesting(undefined);
  await harness.close();
}, 60_000);

describe.skipIf(!available)("several workers at once", () => {
  it("run each of 60 jobs exactly once", async () => {
    for (let index = 0; index < 60; index += 1) await enqueueJob({ kind: "count", payload: { index } });

    const runs = new Map<string, number>();
    const handlers = {
      count: async (_payload: Record<string, unknown>, context: { jobId: string }) => {
        runs.set(context.jobId, (runs.get(context.jobId) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      },
    };

    const reports = await Promise.all(
      Array.from({ length: 6 }, (_, worker) => runDueJobs(handlers, { workerId: `worker-${worker}`, limit: 4 })),
    );

    expect(runs.size).toBe(60);
    expect([...runs.values()].every((times) => times === 1)).toBe(true);
    expect(reports.reduce((sum, report) => sum + report.succeeded, 0)).toBe(60);
    const rows = await harness.db.select({ status: jobs.status }).from(jobs);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
  }, 120_000);

  it("send each of 30 messages exactly once", async () => {
    const sends = new Map<string, number>();
    const provider = {
      name: "counting",
      async send(message: { recipient: string }) {
        sends.set(message.recipient, (sends.get(message.recipient) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { providerMessageId: "x" };
      },
    } as unknown as NotificationProvider;
    setNotificationProviderForTesting(provider);

    await harness.db.insert(notifications).values(
      Array.from({ length: 30 }, (_, index) => ({
        recipient: `drain${index}@example.test`,
        channel: "email",
        template: "order.placed",
        subject: "Hello",
        body: "Body",
        dedupeKey: `drain:${index}`,
      })),
    );

    await Promise.all(Array.from({ length: 5 }, () => deliverQueuedNotifications(10)));
    await deliverQueuedNotifications(50);

    expect(sends.size).toBe(30);
    expect([...sends.values()].every((times) => times === 1)).toBe(true);
  }, 120_000);
});

describe.skipIf(available)("jobs concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
