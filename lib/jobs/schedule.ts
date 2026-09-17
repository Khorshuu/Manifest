import { eq } from "drizzle-orm";
import { db } from "@/db";
import { schedulerHeartbeats } from "@/db/schema";
import type { RecurringJob } from "./runner";

/**
 * How often each recurring job runs, per environment (D-059).
 *
 * The registry holds the defaults. An environment overrides any of them with
 * `JOB_SCHEDULE`, a comma-separated list of `kind=minutes` or `kind=off`:
 *
 *   JOB_SCHEDULE="notifications.deliver=5,media.sweep_unreferenced=off"
 *
 * so staging can run the sweep less often, or not at all, without a code
 * change. A mistake in the variable never switches a job off by accident: an
 * entry that names an unknown job or an impossible interval is reported and
 * that job keeps its default.
 *
 * This decides how often work is *enqueued* when the scheduler calls in; the
 * scheduler itself (Vercel Cron or an external caller of /api/cron/jobs) has
 * to call at least as often as the shortest interval, and `schedulerHealth`
 * says when it does not.
 */

export const MAX_INTERVAL_MINUTES = 24 * 60;

export type ResolvedSchedule = {
  jobs: RecurringJob[];
  /** Jobs this environment has switched off. */
  disabled: string[];
  /** Entries that were ignored, in words an operator can act on. */
  problems: string[];
};

export function resolveRecurringJobs(
  defaults: RecurringJob[],
  spec: string | undefined = process.env.JOB_SCHEDULE,
): ResolvedSchedule {
  const intervals = new Map<string, number | "off">();
  const problems: string[] = [];
  const known = new Set(defaults.map((job) => job.kind));

  for (const raw of (spec ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;

    const match = /^([a-z0-9_.]+)\s*=\s*(\S+)$/i.exec(entry);
    if (!match) {
      problems.push(`"${entry}" is not kind=minutes or kind=off.`);
      continue;
    }
    const [, kind, value] = match;
    if (!known.has(kind)) {
      problems.push(`"${kind}" is not a recurring job.`);
      continue;
    }
    if (value.toLowerCase() === "off") {
      intervals.set(kind, "off");
      continue;
    }
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
      problems.push(
        `"${entry}": the interval must be a whole number of minutes from 1 to ${MAX_INTERVAL_MINUTES}; the default is kept.`,
      );
      continue;
    }
    intervals.set(kind, minutes);
  }

  const jobs: RecurringJob[] = [];
  const disabled: string[] = [];
  for (const job of defaults) {
    const override = intervals.get(job.kind);
    if (override === "off") disabled.push(job.kind);
    else jobs.push(override === undefined ? job : { ...job, everyMinutes: override });
  }
  return { jobs, disabled, problems };
}

/** The name the job trigger records its runs under. */
export const JOB_TRIGGER = "jobs";

export async function recordSchedulerRun(
  name: string,
  report: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(schedulerHeartbeats)
    .values({ name, lastRunAt: now, lastReport: report })
    .onConflictDoUpdate({
      target: schedulerHeartbeats.name,
      set: { lastRunAt: now, lastReport: report },
    });
}

export type SchedulerHealth = {
  lastRunAt: Date | null;
  /** The shortest interval configured: the scheduler must call at least this often. */
  expectedEveryMinutes: number | null;
  /** True when the scheduler has not called in for three expected intervals (at least 10 minutes). */
  stale: boolean;
};

export async function schedulerHealth(
  jobs: RecurringJob[],
  now: Date = new Date(),
): Promise<SchedulerHealth> {
  const [row] = await db
    .select({ lastRunAt: schedulerHeartbeats.lastRunAt })
    .from(schedulerHeartbeats)
    .where(eq(schedulerHeartbeats.name, JOB_TRIGGER));

  const expectedEveryMinutes = jobs.length
    ? Math.min(...jobs.map((job) => job.everyMinutes))
    : null;
  const lastRunAt = row?.lastRunAt ?? null;
  if (expectedEveryMinutes === null) {
    return { lastRunAt, expectedEveryMinutes, stale: false };
  }
  const allowedMs = Math.max(10, 3 * expectedEveryMinutes) * 60_000;
  const stale = lastRunAt === null || now.getTime() - lastRunAt.getTime() > allowedMs;
  return { lastRunAt, expectedEveryMinutes, stale };
}
