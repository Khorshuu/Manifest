import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { toErrorResponse } from "@/lib/api-error";
import { isAuthorisedScheduler } from "@/lib/cron-auth";
import { JOB_HANDLERS, RECURRING_JOBS } from "@/lib/jobs/registry";
import { runDueJobs, scheduleRecurringJobs } from "@/lib/jobs/runner";
import { JOB_TRIGGER, recordSchedulerRun, resolveRecurringJobs } from "@/lib/jobs/schedule";
import { logEvent } from "@/lib/observability/log";

/**
 * The job runner's trigger (DECISIONS.md D-053): schedule whatever recurring
 * work is due in this time slot, then run due jobs until the time budget is
 * nearly spent. Safe to call as often as a scheduler likes — scheduling is
 * deduplicated per slot and jobs are claimed with SKIP LOCKED.
 *
 * Intervals come from the registry, overridden per environment by
 * JOB_SCHEDULE (lib/jobs/schedule.ts, D-059). Each run records a heartbeat so
 * a scheduler that stops calling is visible rather than silent.
 */

export const maxDuration = 60;

async function run() {
  if (!isAuthorisedScheduler((await headers()).get("authorization"))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  try {
    const schedule = resolveRecurringJobs(RECURRING_JOBS);
    if (schedule.problems.length > 0) {
      await logEvent("error", "jobs.schedule_invalid", { problems: schedule.problems });
    }
    const scheduled = await scheduleRecurringJobs(schedule.jobs);
    const report = await runDueJobs(JOB_HANDLERS, { budgetMs: 45_000 });
    const summary = {
      scheduled,
      recovered: report.recovered,
      succeeded: report.succeeded,
      retried: report.retried,
      dead: report.dead,
    };
    await recordSchedulerRun(JOB_TRIGGER, { ...summary, disabled: schedule.disabled });
    await logEvent("info", "jobs.trigger", { ...summary, disabled: schedule.disabled });
    return NextResponse.json(summary);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Vercel Cron issues a GET; other schedulers commonly POST. Both work. */
export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
