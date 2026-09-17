import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { setPolicyStatus } from "@/lib/pkb/trust";

/**
 * Verification policies decide what counts as evidence enough for VERIFIED.
 * Turning one on or off changes what may be verified from now on; nothing
 * already verified is re-decided by it.
 */
const schema = z.object({ policyId: z.string().uuid(), status: z.enum(["active", "retired"]) });

export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    return NextResponse.json(await setPolicyStatus(await getCurrentUser(), parsed.data.policyId, parsed.data.status));
  } catch (error) {
    return toErrorResponse(error);
  }
}
