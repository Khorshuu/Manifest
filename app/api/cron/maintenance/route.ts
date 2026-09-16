import { NextResponse } from "next/server";
import { isAuthorisedScheduler } from "@/lib/cron-auth";
import { headers } from "next/headers";
import { toErrorResponse } from "@/lib/api-error";
import { deleteExpiredSessions } from "@/lib/auth/session";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { expireUnpaidOrders } from "@/lib/orders/expiry";
import { pruneRateLimits } from "@/lib/rate-limit";
import { processSearchQueue } from "@/lib/search/maintenance";
import { pruneSearchLogs } from "@/lib/search/analytics";
import { releaseExpiredSkuReservations } from "@/lib/catalog/sku";

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


/** How many messages one run will attempt. Bounded so a run cannot hang. */
const BATCH_SIZE = 100;

async function run() {
  const headerList = await headers();

  if (!isAuthorisedScheduler(headerList.get("authorization"))) {
    // Deliberately identical whether the secret is unset, missing or wrong:
    // the response says nothing about which.
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  try {
    // First, so the cancellation messages it queues go out in this run.
    const unpaidOrders = await expireUnpaidOrders();

    const delivery = await deliverQueuedNotifications(BATCH_SIZE);

    // Housekeeping that otherwise only happened opportunistically on a request.
    const prunedRateLimits = await pruneRateLimits();
    await deleteExpiredSessions();

    // Search index rows whose rebuild failed at commit, and analytics past
    // their six months.
    const searchIndex = await processSearchQueue();
    const prunedSearchLogs = await pruneSearchLogs();

    // SKUs held by Add Product forms nobody saved go back into use.
    const releasedSkuHolds = await releaseExpiredSkuReservations();

    return NextResponse.json({
      expiredUnpaidOrders: unpaidOrders.expired.length,
      delivery,
      prunedRateLimits,
      searchIndex,
      prunedSearchLogs,
      releasedSkuHolds,
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
