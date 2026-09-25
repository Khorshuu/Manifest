import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, schedulerHeartbeats } from "@/db/schema";
import { JOB_TRIGGER, resolveRecurringJobs } from "@/lib/jobs/schedule";

/**
 * Whether a preparation run is waiting on background processing that is not
 * running (D-121).
 *
 * Preparation happens in background jobs, and background jobs run only when
 * the scheduler calls /api/cron/jobs. When nothing calls it — on a development
 * machine where `npm run jobs:dev` was never started, or a hosted scheduler
 * that stopped — the run's first job stays queued and the editor used to say
 * "Working…" for ever.
 *
 * No new timer: the answer comes from the scheduler's existing heartbeat and
 * the run's own queued job. A run is waiting for the background service only
 * when its job is due, is not claimed, has been due for longer than
 * three scheduler intervals, and the scheduler has not called in since the job
 * became due. A job that is simply taking a few seconds is claimed, so it
 * never qualifies; nor does a job queued for later.
 */

export type BackgroundState = "running" | "waiting_for_background";

/** Three expected scheduler intervals, and never less than two minutes. */
export function backgroundGraceMs(expectedEveryMinutes: number | null): number {
  const every = expectedEveryMinutes ?? 1;
  return Math.max(2, 3 * every) * 60_000;
}

/** Pure, so the rule can be tested without a clock or a database. */
export function assessBackground(input: {
  /** The run's oldest due, unclaimed preparation job, if any. */
  waitingJob: { runAt: Date } | null;
  lastHeartbeatAt: Date | null;
  expectedEveryMinutes: number | null;
  now: Date;
}): BackgroundState {
  const { waitingJob, lastHeartbeatAt, now } = input;
  if (!waitingJob) return "running";
  const dueFor = now.getTime() - waitingJob.runAt.getTime();
  if (dueFor <= backgroundGraceMs(input.expectedEveryMinutes)) return "running";
  // The scheduler called after the job became due and still did not take it:
  // it is running, just busy or behind. That is not "offline".
  if (lastHeartbeatAt && lastHeartbeatAt.getTime() >= waitingJob.runAt.getTime()) return "running";
  return "waiting_for_background";
}

/** Reads the run's waiting job and the heartbeat, and applies the rule. */
export async function preparationBackgroundState(
  runId: string,
  /** The preparation job kind, passed in so this module imports nothing from the service. */
  jobKind: string,
  now: Date = new Date(),
): Promise<BackgroundState> {
  const [waitingJob] = await db
    .select({ runAt: jobs.runAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, jobKind),
        eq(jobs.status, "queued"),
        isNull(jobs.lockedAt),
        lte(jobs.runAt, now),
        sql`${jobs.payload}->>'runId' = ${runId}`,
      ),
    )
    .orderBy(asc(jobs.runAt))
    .limit(1);
  if (!waitingJob) return "running";

  const [heartbeat] = await db
    .select({ lastRunAt: schedulerHeartbeats.lastRunAt })
    .from(schedulerHeartbeats)
    .where(eq(schedulerHeartbeats.name, JOB_TRIGGER));
  // Imported here, not at the top: the job registry imports preparation.
  const { RECURRING_JOBS } = await import("@/lib/jobs/registry");
  const schedule = resolveRecurringJobs(RECURRING_JOBS);
  const expectedEveryMinutes = schedule.jobs.length ? Math.min(...schedule.jobs.map((job) => job.everyMinutes)) : null;

  return assessBackground({
    waitingJob,
    lastHeartbeatAt: heartbeat?.lastRunAt ?? null,
    expectedEveryMinutes,
    now,
  });
}
