import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { markInboxSeen } from "@/lib/admin";
import { getCurrentUser } from "@/lib/auth";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/** Marks the caller's admin inbox read up to now. Staff only (in lib). */
export async function POST() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    const user = await getCurrentUser();
    const seenAt = await markInboxSeen(user);
    return NextResponse.json({ seenAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}
