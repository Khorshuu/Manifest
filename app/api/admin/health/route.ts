import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { requirePermission } from "@/lib/auth/authorize";
import { systemHealth } from "@/lib/health";

/**
 * The environment's health for staff (D-133): database, job queue and
 * whoever drains it, message delivery, research and AI services. Needs
 * `notifications.view`, the permission that already gates the operational
 * screens. States and counts only; no address, key or customer data.
 */
export async function GET() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    requirePermission(await getCurrentUser(), "notifications.view");
    return NextResponse.json(await systemHealth(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
