import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { isAuthorisedScheduler } from "@/lib/cron-auth";
import { systemHealth } from "@/lib/health";
import { logEvent } from "@/lib/observability/log";

/**
 * The environment's health for a monitor (D-133): the same report staff see
 * at `/api/admin/health`, for a machine holding CRON_SECRET. Not public — an
 * unauthenticated caller learns nothing, not even whether the site is up;
 * point a plain uptime check at `/` instead.
 *
 * 200 when everything is working or only degraded (the report says which),
 * 503 when the database cannot be reached, so a monitor that only reads the
 * status alerts on the one failure that takes the shop down.
 */

export const maxDuration = 30;

export async function GET() {
  if (!isAuthorisedScheduler((await headers()).get("authorization"))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  try {
    const health = await systemHealth();
    return NextResponse.json(health, {
      status: health.status === "down" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    await logEvent("error", "health.check_failed", { error });
    return NextResponse.json({ status: "down", problems: ["The health check itself failed."] }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
