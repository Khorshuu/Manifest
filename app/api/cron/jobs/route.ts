import { after, NextResponse } from "next/server";
import { headers } from "next/headers";
import { toErrorResponse } from "@/lib/api-error";
import { isAuthorisedScheduler } from "@/lib/cron-auth";
import { JOB_HANDLERS, jobPolicies, RECURRING_JOBS } from "@/lib/jobs/registry";
import { runDueJobs, runLocalAiJob, scheduleRecurringJobs } from "@/lib/jobs/runner";
import { jobRunnerMode } from "@/lib/jobs/mode";
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
 *
 * A local-AI job (D-127) takes minutes, so it is not run inside this request:
 * after the response, one due local-AI job runs holding the local-AI slot. A
 * scheduler tick that arrives meanwhile finds the slot taken and leaves the
 * next one queued.
 *
 * Where a worker runs the jobs (`JOB_RUNNER=worker`, D-133) this trigger
 * declines: the research and AI services are private to the worker, and a
 * job claimed here would fail for want of them. A scheduler that still calls
 * is answered 200 and told so, and nothing is claimed.
 */

export const maxDuration = 60;

async function run() {
  if (!isAuthorisedScheduler((await headers()).get("authorization"))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  if (jobRunnerMode() === "worker") {
    return NextResponse.json({ skipped: true, reason: "Background jobs run in the worker in this environment." });
  }

  try {
    const schedule = resolveRecurringJobs(RECURRING_JOBS);
    if (schedule.problems.length > 0) {
      await logEvent("error", "jobs.schedule_invalid", { problems: schedule.problems });
    }
    const scheduled = await scheduleRecurringJobs(schedule.jobs);
    const policies = jobPolicies();
    const report = await runDueJobs(JOB_HANDLERS, { budgetMs: 45_000, policies, localAiLane: false });
    after(async () => {
      try {
        const lane = await runLocalAiJob(JOB_HANDLERS, { policies });
        if (lane.ran.length > 0) await logEvent("info", "jobs.local_ai", { ran: lane.ran });
      } catch (error) {
        await logEvent("error", "jobs.local_ai_failed", { error });
      }
    });
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
