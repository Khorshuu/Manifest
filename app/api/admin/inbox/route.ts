import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { markInboxSeen } from "@/lib/admin";
import { getCurrentUser } from "@/lib/auth";

/** Marks the caller's admin inbox read up to now. Staff only (in lib). */
export async function POST() {
  try {
    const user = await getCurrentUser();
    const seenAt = await markInboxSeen(user);
    return NextResponse.json({ seenAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}
