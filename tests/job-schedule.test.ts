/**
 * Recurring job intervals per environment (JOB_SCHEDULE) and the scheduler
 * heartbeat that makes a stopped scheduler visible (D-059).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs, schedulerHeartbeats } from "@/db/schema";
import { RECURRING_JOBS } from "@/lib/jobs/registry";
import { scheduleRecurringJobs } from "@/lib/jobs/runner";
import {
  JOB_TRIGGER,
  recordSchedulerRun,
  resolveRecurringJobs,
  schedulerHealth,
} from "@/lib/jobs/schedule";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

const MINUTE = 60_000;
const intervalOf = (schedule: ReturnType<typeof resolveRecurringJobs>, kind: string) =>
  schedule.jobs.find((job) => job.kind === kind)?.everyMinutes;

describe("JOB_SCHEDULE", () => {
  it("uses the registry defaults when unset", () => {
    const schedule = resolveRecurringJobs(RECURRING_JOBS, undefined);
    expect(schedule.jobs).toEqual(RECURRING_JOBS);
    expect(schedule.disabled).toEqual([]);
    expect(schedule.problems).toEqual([]);
  });

  it("overrides an interval and switches a job off", () => {
    const schedule = resolveRecurringJobs(
      RECURRING_JOBS,
      " notifications.deliver = 5 , media.sweep_unreferenced=off",
    );
    expect(intervalOf(schedule, "notifications.deliver")).toBe(5);
    expect(intervalOf(schedule, "media.sweep_unreferenced")).toBeUndefined();
    expect(schedule.disabled).toEqual(["media.sweep_unreferenced"]);
    expect(intervalOf(schedule, "orders.expire_unpaid")).toBe(2);
    expect(schedule.problems).toEqual([]);
  });

  it("keeps the default and reports a mistake instead of switching a job off", () => {
    const schedule = resolveRecurringJobs(
      RECURRING_JOBS,
      "orders.expire_unpaid=0,notifications.deliver=1.5,payments.reconcile=99999,orders.expire_unpiad=3,garbage",
    );
    expect(intervalOf(schedule, "orders.expire_unpaid")).toBe(2);
    expect(intervalOf(schedule, "notifications.deliver")).toBe(1);
    expect(intervalOf(schedule, "payments.reconcile")).toBe(10);
    expect(schedule.disabled).toEqual([]);
    expect(schedule.problems).toHaveLength(5);
    expect(schedule.problems.join(" ")).toContain("orders.expire_unpiad");
  });

  it("enqueues nothing for a job switched off", async () => {
    const schedule = resolveRecurringJobs(RECURRING_JOBS, "media.sweep_unreferenced=off");
    await scheduleRecurringJobs(schedule.jobs, new Date("2026-09-17T10:00:00Z"));
    const kinds = (await harness.db.select({ kind: jobs.kind }).from(jobs)).map((row) => row.kind);
    expect(kinds).not.toContain("media.sweep_unreferenced");
    expect(kinds).toContain("orders.expire_unpaid");
  });
});

describe("scheduler health", () => {
  const now = new Date("2026-09-17T10:00:00Z");

  it("is stale before the scheduler has ever run", async () => {
    const health = await schedulerHealth(RECURRING_JOBS, now);
    expect(health).toEqual({ lastRunAt: null, expectedEveryMinutes: 1, stale: true });
  });

  it("is healthy while the scheduler calls as often as the shortest interval needs", async () => {
    await recordSchedulerRun(JOB_TRIGGER, { scheduled: 3 }, new Date(now.getTime() - 4 * MINUTE));
    const health = await schedulerHealth(RECURRING_JOBS, now);
    expect(health.stale).toBe(false);
    expect(health.lastRunAt?.toISOString()).toBe(new Date(now.getTime() - 4 * MINUTE).toISOString());
  });

  it("goes stale when the scheduler stops calling — a daily trigger cannot serve a 2-minute expiry", async () => {
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date(now.getTime() - 11 * MINUTE));
    expect((await schedulerHealth(RECURRING_JOBS, now)).stale).toBe(true);
  });

  it("allows three of the shortest intervals when that is longer than ten minutes", async () => {
    const hourly = resolveRecurringJobs(
      RECURRING_JOBS,
      RECURRING_JOBS.map((job) => `${job.kind}=60`).join(","),
    );
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date(now.getTime() - 170 * MINUTE));
    expect((await schedulerHealth(hourly.jobs, now)).stale).toBe(false);
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date(now.getTime() - 181 * MINUTE));
    expect((await schedulerHealth(hourly.jobs, now)).stale).toBe(true);
  });

  it("keeps one row per trigger, updated in place", async () => {
    await recordSchedulerRun(JOB_TRIGGER, { scheduled: 1 }, new Date(now.getTime() - 2 * MINUTE));
    await recordSchedulerRun(JOB_TRIGGER, { scheduled: 2 }, now);
    const rows = await harness.db.select().from(schedulerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastReport).toEqual({ scheduled: 2 });
  });
});
