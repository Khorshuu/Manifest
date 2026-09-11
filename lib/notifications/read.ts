import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications, orders } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

export type OutboxRow = {
  id: string;
  orderNumber: string | null;
  recipient: string;
  channel: string;
  template: string;
  subject: string;
  status: string;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
};

/**
 * The outbox as staff see it. Staff-only: it carries every customer's contact
 * address, so it is never reachable from a customer session (docs/SECURITY.md).
 */
export async function listOutbox(
  actor: SessionUser | null,
  limit = 100,
): Promise<OutboxRow[]> {
  requirePermission(actor, "notifications.view");

  return db
    .select({
      id: notifications.id,
      orderNumber: orders.orderNumber,
      recipient: notifications.recipient,
      channel: notifications.channel,
      template: notifications.template,
      subject: notifications.subject,
      status: notifications.status,
      error: notifications.error,
      createdAt: notifications.createdAt,
      sentAt: notifications.sentAt,
    })
    .from(notifications)
    .leftJoin(orders, eq(orders.id, notifications.orderId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export type OutboxCounts = { queued: number; sent: number; failed: number };

/** Real counts from the table — no dashboard number is invented. */
export async function countOutboxByStatus(
  actor: SessionUser | null,
): Promise<OutboxCounts> {
  requirePermission(actor, "notifications.view");

  const rows = await db
    .select({ status: notifications.status })
    .from(notifications);

  const counts: OutboxCounts = { queued: 0, sent: 0, failed: 0 };

  for (const row of rows) {
    if (row.status === "queued") counts.queued += 1;
    else if (row.status === "sent") counts.sent += 1;
    else if (row.status === "failed") counts.failed += 1;
  }

  return counts;
}
