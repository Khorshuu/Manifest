import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications, orders, users } from "@/db/schema";
import {
  DeliveryError,
  getNotificationProvider,
} from "@/lib/providers/notification";
import {
  composeOrderMessage,
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
 * Delivers queued messages. Safe to call repeatedly: a row moves out of
 * 'queued' before its outcome is known to the caller, and a failure keeps the
 * reason on the row for staff rather than surfacing it to the customer.
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
    })
    .from(notifications)
    .where(and(eq(notifications.status, "queued"), isNull(notifications.sentAt)))
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
        .set({ status: "failed", error: reason })
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
