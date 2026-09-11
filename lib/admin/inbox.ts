import { and, desc, eq, gte, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications, orders, reviews, users } from "@/db/schema";
import { can, requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { getStockAlerts } from "./insights";

/**
 * The admin inbox (DECISIONS.md D-036).
 *
 * Nothing here is stored as a notification. Each item is read live from the
 * row that records the event — the order, the failed message, the review, the
 * variant running out — so the inbox can never claim something the data does
 * not say, and dealing with the underlying thing is what clears it from the
 * "needs action" kinds. The only thing stored is when each staff member last
 * read the inbox, which is what makes an item unread.
 *
 * Each source is included only for a role that could act on it.
 */

export type InboxKind =
  | "new_order"
  | "awaiting_payment"
  | "cancellation"
  | "failed_message"
  | "stock"
  | "new_customer"
  | "pending_review";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  title: string;
  detail: string;
  href: string;
  at: Date;
  /** Something waiting on a person, rather than something to know. */
  needsAction: boolean;
};

/** How far back the inbox looks. Older events are history, not news. */
const WINDOW_DAYS = 30;

export async function getInbox(actor: SessionUser | null) {
  const user = requireStaff(actor);
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const items: InboxItem[] = [];

  const [me] = await db
    .select({ seenAt: users.adminInboxSeenAt })
    .from(users)
    .where(eq(users.id, user.id));
  const seenAt = me?.seenAt ?? null;

  const tasks: Promise<void>[] = [];

  if (can(user, "orders.view")) {
    tasks.push(
      db
        .select({
          id: orders.id,
          number: orders.orderNumber,
          status: orders.status,
          placedAt: orders.placedAt,
          email: sql<string | null>`coalesce(${users.email}, ${orders.guestEmail})`,
          firstName: users.firstName,
        })
        .from(orders)
        .leftJoin(users, eq(orders.userId, users.id))
        .where(gte(orders.placedAt, since))
        .orderBy(desc(orders.placedAt))
        .limit(40)
        .then((rows) => {
          for (const row of rows) {
            items.push({
              id: `order-${row.id}`,
              kind: "new_order",
              title: `New order ${row.number}`,
              detail: row.firstName ?? row.email ?? "Guest",
              href: `/admin/orders/${row.id}`,
              at: row.placedAt,
              needsAction: false,
            });
            if (row.status === "placed" && row.placedAt < dayAgo) {
              items.push({
                id: `unpaid-${row.id}`,
                kind: "awaiting_payment",
                title: `${row.number} still unpaid after a day`,
                detail: "Chase the customer or let it lapse.",
                href: `/admin/orders/${row.id}`,
                at: new Date(row.placedAt.getTime() + 24 * 60 * 60 * 1000),
                needsAction: true,
              });
            }
          }
        }),
      db
        .select({
          id: orders.id,
          number: orders.orderNumber,
          at: orders.cancellationRequestedAt,
        })
        .from(orders)
        .where(
          and(
            isNotNull(orders.cancellationRequestedAt),
            notInArray(orders.status, ["cancelled", "refunded"]),
          ),
        )
        .then((rows) => {
          for (const row of rows) {
            items.push({
              id: `cancel-${row.id}`,
              kind: "cancellation",
              title: `Cancellation requested on ${row.number}`,
              detail: "Approve or decline it on the order.",
              href: `/admin/orders/${row.id}`,
              at: row.at!,
              needsAction: true,
            });
          }
        }),
    );
  }

  if (can(user, "notifications.view")) {
    tasks.push(
      db
        .select({
          id: notifications.id,
          subject: notifications.subject,
          recipient: notifications.recipient,
          error: notifications.error,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(and(eq(notifications.status, "failed"), gte(notifications.createdAt, since)))
        .orderBy(desc(notifications.createdAt))
        .limit(20)
        .then((rows) => {
          for (const row of rows) {
            items.push({
              id: `message-${row.id}`,
              kind: "failed_message",
              title: `Message failed: ${row.subject}`,
              detail: `${row.recipient}${row.error ? ` — ${row.error}` : ""}`,
              href: "/admin/notifications?tab=messages&status=failed",
              at: row.createdAt,
              needsAction: true,
            });
          }
        }),
    );
  }

  if (can(user, "catalog.manage")) {
    tasks.push(
      getStockAlerts(user, 12).then((alerts) => {
        for (const alert of alerts) {
          const text =
            alert.kind === "out_of_stock"
              ? "Out of stock"
              : alert.kind === "low_stock"
                ? `${alert.remaining} left in stock`
                : alert.kind === "preorder_full"
                  ? "Preorder batch is full"
                  : `${alert.remaining} preorder places left`;
          items.push({
            id: `stock-${alert.variantId}-${alert.kind}`,
            kind: "stock",
            title: `${alert.title} (${alert.sku})`,
            detail: text,
            href: `/admin/products/${alert.productId}`,
            // A level, not an event: it is current as of now.
            at: new Date(),
            needsAction: alert.kind === "out_of_stock" || alert.kind === "preorder_full",
          });
        }
      }),
    );
  }

  if (can(user, "customers.view")) {
    tasks.push(
      db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(eq(users.role, "customer"), gte(users.createdAt, since)))
        .orderBy(desc(users.createdAt))
        .limit(20)
        .then((rows) => {
          for (const row of rows) {
            items.push({
              id: `customer-${row.id}`,
              kind: "new_customer",
              title: `New customer${row.firstName ? `: ${row.firstName}` : ""}`,
              detail: row.email,
              href: `/admin/customers?q=${encodeURIComponent(row.email)}`,
              at: row.createdAt,
              needsAction: false,
            });
          }
        }),
    );
  }

  if (can(user, "reviews.moderate")) {
    tasks.push(
      db
        .select({ id: reviews.id, createdAt: reviews.createdAt, rating: reviews.rating })
        .from(reviews)
        .where(eq(reviews.status, "pending"))
        .orderBy(desc(reviews.createdAt))
        .limit(20)
        .then((rows) => {
          for (const row of rows) {
            items.push({
              id: `review-${row.id}`,
              kind: "pending_review",
              title: `A ${row.rating}-star review is waiting`,
              detail: "Approve or reject it before it shows.",
              href: "/admin/reviews",
              at: row.createdAt,
              needsAction: true,
            });
          }
        }),
    );
  }

  await Promise.all(tasks);
  items.sort((a, b) => b.at.getTime() - a.at.getTime());

  const isUnread = (item: InboxItem) =>
    item.kind === "stock" ? false : seenAt === null || item.at > seenAt;

  return {
    seenAt,
    items: items.map((item) => ({ ...item, unread: isUnread(item) })),
    unread: items.filter(isUnread).length,
    needsAction: items.filter((item) => item.needsAction).length,
  };
}

/** Marks everything up to now as read, for this staff member only. */
export async function markInboxSeen(actor: SessionUser | null): Promise<Date> {
  const user = requireStaff(actor);
  const now = new Date();
  await db
    .update(users)
    .set({ adminInboxSeenAt: now })
    .where(and(eq(users.id, user.id), lt(sql`coalesce(${users.adminInboxSeenAt}, 'epoch')`, now)));
  return now;
}
