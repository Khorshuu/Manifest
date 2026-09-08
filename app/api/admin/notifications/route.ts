import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "@/lib/auth/authorize";
import { deliverQueuedNotifications } from "@/lib/notifications";

/** Drains the outbox on demand. Staff only — it sends to real customers. */
export async function POST() {
  try {
    const user = await getCurrentUser();
    requireStaff(user);

    const report = await deliverQueuedNotifications();
    return NextResponse.json({ report });
  } catch (error) {
    return toErrorResponse(error);
  }
}
