import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications, orders, payments, users } from "@/db/schema";
import {
  DeliveryError,
  getNotificationProvider,
} from "@/lib/providers/notification";
import {
  composeBalanceMessage,
  composeOrderMessage,
  composePartialRefundMessage,
  isNotifiedStatus,
  type NotifiedStatus,
} from "./templates";

/**
 * The outbox, written and drained in two steps.
 *
 * `queueOrderNotification` runs inside the caller's transaction, so a message
 * exists if and only if the change that caused it was committed. Delivery is a
 * separate step that can fail and be retried without touching the order.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the base
   database or an open transaction; they differ only in generics */
type Executor = any;

export type QueuedNotification = {
  id: string;
  dedupeKey: string;
  recipient: string;
  subject: string;
};

/**
 * Queues the message for an order reaching a status. Returns null when there
 * is nothing to send: a status nobody is told about, an order with no contact
 * address, or a message already queued for this exact event.
 */
export async function queueOrderNotification(
  tx: Executor,
  orderId: string,
  status: string,
): Promise<QueuedNotification | null> {
  if (!isNotifiedStatus(status)) return null;

  const [order] = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
      userId: orders.userId,
      guestEmail: orders.guestEmail,
      userEmail: users.email,
    })
    .from(orders)
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  // A guest order carries its own address; a signed-in order uses the account.
  const recipient = order.userEmail ?? order.guestEmail;
  if (!recipient) return null;

  const message = composeOrderMessage(status as NotifiedStatus, {
    orderNumber: order.orderNumber,
    totalBdt: order.totalBdt,
    amountDueNowBdt: order.amountDueNowBdt,
  });

  const dedupeKey = `order:${orderId}:${status}`;

  const [row] = await tx
    .insert(notifications)
    .values({
      orderId,
      userId: order.userId,
      recipient,
      channel: "email",
      template: `order.${status}`,
      subject: message.subject,
      body: message.body,
      dedupeKey,
    })
    // The replay guard. A repeated webhook writes the same key and is dropped
    // here rather than telling the customer twice (CLAUDE.md section 7).
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      recipient: notifications.recipient,
      subject: notifications.subject,
    });

  return row ?? null;
}

export type DeliveryReport = {
  attempted: number;
  sent: number;
  failed: number;
};

/**
 * A message that has failed this many times is left alone. Retrying a bad
 * address forever costs money at a real provider and buries the failures that
 * could still be fixed.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Delivers what is waiting: queued messages, and failed ones with attempts
 * left. Safe to call repeatedly and safe to call concurrently with itself —
 * the worst case is a message delivered twice rather than not at all, and a
 * failure keeps its reason on the row for staff rather than reaching the
 * customer.
 */
export async function deliverQueuedNotifications(
  limit = 50,
): Promise<DeliveryReport> {
  const queued = await db
    .select({
      id: notifications.id,
      channel: notifications.channel,
      recipient: notifications.recipient,
      subject: notifications.subject,
      body: notifications.body,
      attempts: notifications.attempts,
    })
    .from(notifications)
    .where(
      and(
        isNull(notifications.sentAt),
        // Queued messages, and failed ones that have not run out of attempts:
        // a provider outage should recover by itself on the next drain rather
        // than needing someone to notice and press a button.
        or(
          eq(notifications.status, "queued"),
          and(
            eq(notifications.status, "failed"),
            lt(notifications.attempts, MAX_DELIVERY_ATTEMPTS),
          ),
        ),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(limit);

  const report: DeliveryReport = { attempted: queued.length, sent: 0, failed: 0 };
  const provider = getNotificationProvider();

  for (const message of queued) {
    try {
      const result = await provider.send({
        channel: message.channel === "sms" ? "sms" : "email",
        recipient: message.recipient,
        subject: message.subject,
        body: message.body,
      });

      await db
        .update(notifications)
        .set({
          status: "sent",
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          attempts: message.attempts + 1,
          error: null,
        })
        .where(eq(notifications.id, message.id));

      report.sent += 1;
    } catch (error) {
      const reason =
        error instanceof DeliveryError || error instanceof Error
          ? error.message
          : "Delivery failed.";

      await db
        .update(notifications)
        .set({
          status: "failed",
          attempts: message.attempts + 1,
          error: reason,
        })
        .where(eq(notifications.id, message.id));

      report.failed += 1;
    }
  }

  return report;
}

/**
 * Delivery attempted alongside a request, without letting a provider outage
 * fail the request that queued the message. The row stays queued and a later
 * drain picks it up.
 */
export function deliverQueuedNotificationsInBackground(): void {
  if (!backgroundDelivery) return;

  void deliverQueuedNotifications().catch(() => {
    // Swallowed on purpose: the outbox row is the record, not this call.
  });
}

let backgroundDelivery = true;

/**
 * Test helper. With this off, a test can observe the queued row before
 * anything delivers it, which is otherwise a race against a promise nobody
 * awaits.
 */
export function setBackgroundDeliveryForTesting(enabled: boolean): void {
  backgroundDelivery = enabled;
}

/**
 * Queues the message for a balance taken on a deposit order.
 *
 * Separate from `queueOrderNotification` because this is not an order status:
 * the fulfilment stage does not move when money changes hands, and a template
 * keyed on status could not describe it.
 */
export async function queueBalanceNotification(
  tx: Executor,
  orderId: string,
  amountBdt: number,
): Promise<QueuedNotification | null> {
  const [order] = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalBdt: orders.totalBdt,
      userId: orders.userId,
      guestEmail: orders.guestEmail,
      userEmail: users.email,
    })
    .from(orders)
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  const recipient = order.userEmail ?? order.guestEmail;
  if (!recipient) return null;

  const message = composeBalanceMessage({
    orderNumber: order.orderNumber,
    amountBdt,
    totalBdt: order.totalBdt,
  });

  const [row] = await tx
    .insert(notifications)
    .values({
      orderId,
      userId: order.userId,
      recipient,
      channel: "email",
      template: "order.balance_taken",
      subject: message.subject,
      body: message.body,
      // One balance per order, so a repeated collection cannot write twice.
      dedupeKey: `order:${orderId}:balance`,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      recipient: notifications.recipient,
      subject: notifications.subject,
    });

  return row ?? null;
}

/**
 * Queues the message for a partial refund.
 *
 * Keyed on the amount as well as the order, because an order can be partly
 * refunded more than once and each is a separate thing to be told about — the
 * order-status dedupe key would silence every refund after the first.
 */
export async function queuePartialRefundNotification(
  tx: Executor,
  orderId: string,
  amountBdt: number,
): Promise<QueuedNotification | null> {
  const [order] = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalBdt: orders.totalBdt,
      userId: orders.userId,
      guestEmail: orders.guestEmail,
      userEmail: users.email,
    })
    .from(orders)
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  const recipient = order.userEmail ?? order.guestEmail;
  if (!recipient) return null;

  // What has actually been paid, refunds netted off, after this one.
  const [totals] = await tx
    .select({ paid: sql<number>`coalesce(sum(${payments.amountBdt}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), ne(payments.status, "failed")));

  const message = composePartialRefundMessage({
    orderNumber: order.orderNumber,
    amountBdt,
    remainingTotalBdt: Number(totals?.paid ?? 0),
  });

  const [row] = await tx
    .insert(notifications)
    .values({
      orderId,
      userId: order.userId,
      recipient,
      channel: "email",
      template: "order.partial_refund",
      subject: message.subject,
      body: message.body,
      dedupeKey: `order:${orderId}:partial_refund:${amountBdt}:${Date.now()}`,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      recipient: notifications.recipient,
      subject: notifications.subject,
    });

  return row ?? null;
}
