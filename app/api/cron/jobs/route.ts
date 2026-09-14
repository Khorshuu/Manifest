import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { toErrorResponse } from "@/lib/api-error";
import { isAuthorisedScheduler } from "@/lib/cron-auth";
import { JOB_HANDLERS, RECURRING_JOBS } from "@/lib/jobs/registry";
import { runDueJobs, scheduleRecurringJobs } from "@/lib/jobs/runner";

/**
 * The job runner's trigger (DECISIONS.md D-053): schedule whatever recurring
 * work is due in this time slot, then run due jobs until the time budget is
 * nearly spent. Safe to call as often as a scheduler likes — scheduling is
 * deduplicated per slot and jobs are claimed with SKIP LOCKED.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run() {
  if (!isAuthorisedScheduler((await headers()).get("authorization"))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  try {
    const scheduled = await scheduleRecurringJobs(RECURRING_JOBS);
    const report = await runDueJobs(JOB_HANDLERS, { budgetMs: 45_000 });
    return NextResponse.json({
      scheduled,
      recovered: report.recovered,
      succeeded: report.succeeded,
      retried: report.retried,
      dead: report.dead,
    });
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
