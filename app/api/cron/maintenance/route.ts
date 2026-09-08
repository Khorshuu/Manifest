import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { toErrorResponse } from "@/lib/api-error";
import { deleteExpiredSessions } from "@/lib/auth/session";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { pruneRateLimits } from "@/lib/rate-limit";

/**
 * The scheduled sweep: deliver what is waiting, then tidy up.
 *
 * Delivery previously depended on traffic — whichever request queued a message
 * also tried to send it, so a message queued by the last order of the night
 * waited for the first order of the morning. This runs on a clock instead.
 *
 * Not authenticated as a user, because a scheduler is not a person: it carries
 * a shared secret in an Authorization header, which is the format Vercel Cron
 * and most other schedulers send.
 */

export const dynamic = "force-dynamic";

/** How many messages one run will attempt. Bounded so a run cannot hang. */
const BATCH_SIZE = 100;

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;

  // No secret configured means the endpoint is closed, not open. An
  // unauthenticated job runner that anyone can trigger is worse than none.
  if (!secret || secret.length === 0) return false;
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function run() {
  const headerList = await headers();

  if (!authorised(headerList.get("authorization"))) {
    // Deliberately identical whether the secret is unset, missing or wrong:
    // the response says nothing about which.
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  try {
    const delivery = await deliverQueuedNotifications(BATCH_SIZE);

    // Housekeeping that otherwise only happened opportunistically on a request.
    const prunedRateLimits = await pruneRateLimits();
    await deleteExpiredSessions();

    return NextResponse.json({
      delivery,
      prunedRateLimits,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Vercel Cron issues a GET; other schedulers commonly POST. Both work. */
export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
