import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { RECURRING_JOBS } from "@/lib/jobs/registry";
import { jobSummary, retryDeadJob } from "@/lib/jobs/runner";
import { resolveRecurringJobs, schedulerHealth } from "@/lib/jobs/schedule";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/**
 * Background job counts and recent failures, for staff who read notifications,
 * with whether the scheduler is calling in as often as this environment's
 * schedule needs (D-059).
 */
export async function GET() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    const summary = await jobSummary(await getCurrentUser());
    const schedule = resolveRecurringJobs(RECURRING_JOBS);
    const health = await schedulerHealth(schedule.jobs);
    return NextResponse.json({
      ...summary,
      scheduler: {
        ...health,
        jobs: schedule.jobs.map((job) => ({ kind: job.kind, everyMinutes: job.everyMinutes })),
        disabled: schedule.disabled,
        problems: schedule.problems,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const retrySchema = z.object({ jobId: z.string().uuid() }).strict();

/** Puts a dead job back in the queue. The owner only (settings.manage). */
export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = retrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Name the job to retry." }, { status: 400 });
  }
  try {
    return NextResponse.json({ job: await retryDeadJob(await getCurrentUser(), parsed.data.jobId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
