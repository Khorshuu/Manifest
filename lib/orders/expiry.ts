import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orderStatusHistory, orders, payments } from "@/db/schema";
import { getSetting } from "@/lib/admin/settings";
import {
  deliverQueuedNotificationsInBackground,
  queueOrderNotification,
} from "@/lib/notifications";
import { releaseCapacity } from "@/lib/preorder";

/**
 * Unpaid orders give their places back (DECISIONS.md D-052).
 *
 * Placing an order reserves capacity before any money moves. An order still
 * `placed`, with no captured payment, once the hold window
 * (`orders.unpaid_hold_minutes`) has passed is cancelled and its capacity
 * released — without anyone visiting the site, from the scheduled sweep.
 *
 * Safe to run repeatedly and from several workers at once:
 *
 * - each order is handled in its own short transaction, locked with
 *   `FOR UPDATE SKIP LOCKED`, so two sweepers never handle the same order and a
 *   busy order is left for the next sweep rather than waited on;
 * - status and payments are re-read inside that lock, and the cancel is
 *   guarded on `status = 'placed'`, so capacity cannot be released twice;
 * - the payment row is read, never locked. Confirmation locks the payment
 *   and then the order; taking them in the other order here could deadlock.
 *   If a capture is committing at the same instant, the order is cancelled and
 *   the capture is then recorded as money arriving after cancellation, which
 *   staff refund — never an order reinstated into a batch that may have filled.
 */

export type ExpiryReport = { examined: number; expired: string[] };

export async function expireUnpaidOrders(
  options: { now?: Date; limit?: number } = {},
): Promise<ExpiryReport> {
  const now = options.now ?? new Date();
  const minutes = await getSetting("orders.unpaid_hold_minutes");
  const cutoff = new Date(now.getTime() - minutes * 60_000);

  const candidates = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "placed"),
        sql`${orders.archivedAt} is null`,
        sql`${orders.placedAt} < ${cutoff.toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from ${payments} p
          where p.order_id = ${orders.id} and (p.status = 'captured' or p.method = 'cod')
        )`,
      ),
    )
    .orderBy(asc(orders.placedAt))
    .limit(options.limit ?? 200);

  const report: ExpiryReport = { examined: candidates.length, expired: [] };

  for (const candidate of candidates) {
    const expired = await db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.id, candidate.id))
        .for("update", { skipLocked: true });

      if (!order || order.status !== "placed") return false;

      const [settled] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.orderId, order.id),
            or(eq(payments.status, "captured"), eq(payments.method, "cod")),
          ),
        )
        .limit(1);
      if (settled) return false;

      const items = await tx
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        // The same order checkout locks variants in.
        .orderBy(asc(orderItems.variantId));

      for (const item of items) {
        await releaseCapacity(tx, item.variantId, item.quantity);
      }

      await tx
        .update(orders)
        .set({ status: "cancelled" })
        .where(and(eq(orders.id, order.id), eq(orders.status, "placed")));

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        status: "cancelled",
        note: `No payment within ${minutes} minutes, so the order was cancelled and its places released.`,
        actorUserId: null,
      });

      await queueOrderNotification(tx, order.id, "cancelled");
      return true;
    });

    if (expired) report.expired.push(candidate.id);
  }

  if (report.expired.length > 0) deliverQueuedNotificationsInBackground();

  return report;
}
