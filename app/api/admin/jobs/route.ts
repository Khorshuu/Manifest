import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { jobSummary, retryDeadJob } from "@/lib/jobs/runner";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/** Background job counts and recent failures, for staff who read notifications. */
export async function GET() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    return NextResponse.json(await jobSummary(await getCurrentUser()));
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
