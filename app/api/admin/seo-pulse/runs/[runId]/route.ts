import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { getSeoPulseRun } from "@/lib/seo-pulse";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/** One stored research run, for viewing an earlier version. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/admin/seo-pulse/runs/[runId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { runId } = await context.params;
  if (!z.string().uuid().safeParse(runId).success) {
    return NextResponse.json({ error: "That research was not found." }, { status: 404 });
  }

  try {
    const run = await getSeoPulseRun(await getCurrentUser(), runId);
    if (!run) {
      return NextResponse.json({ error: "That research was not found." }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    return toErrorResponse(error);
  }
}
