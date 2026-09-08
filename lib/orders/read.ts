import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  addresses,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
} from "@/db/schema";
import { requireOwnerOrStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/** Orders belonging to a signed-in shopper. */
export async function listOrdersForUser(userId: string) {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.placedAt));
}

async function loadOrder(orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  const [items, history, address, paymentRows] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(orderStatusHistory.createdAt),
    db
      .select()
      .from(addresses)
      .where(eq(addresses.id, order.shippingAddressId))
      .limit(1),
    db.select().from(payments).where(eq(payments.orderId, orderId)),
  ]);

  return {
    ...order,
    items,
    history,
    address: address[0] ?? null,
    payments: paymentRows,
  };
}

/**
 * An order is visible to the shopper who placed it, or to staff. A guest order
 * is looked up separately, by order number and email.
 */
export async function getOrderForUser(
  actor: SessionUser | null,
  orderId: string,
) {
  const order = await loadOrder(orderId);
  if (!order) return null;

  requireOwnerOrStaff(actor, order.userId);
  return order;
}

/** Guest lookup: the order number alone is not enough. */
export async function getGuestOrder(orderNumber: string, email: string) {
  const [match] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber),
        eq(orders.guestEmail, email.trim().toLowerCase()),
      ),
    )
    .limit(1);

  if (!match) return null;
  return loadOrder(match.id);
}

/** Staff view: any order, by id. */
export async function getOrderForStaff(orderId: string) {
  return loadOrder(orderId);
}
