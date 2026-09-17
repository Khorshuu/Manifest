import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "@/lib/auth/authorize";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/** Drains the outbox on demand. Staff only — it sends to real customers. */
export async function POST() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    const user = await getCurrentUser();
    requireStaff(user);

    const report = await deliverQueuedNotifications();
    return NextResponse.json({ report });
  } catch (error) {
    return toErrorResponse(error);
  }
}
