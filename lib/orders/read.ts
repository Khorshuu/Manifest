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

/**
 * Reading orders.
 *
 * The customer-facing loader selects its columns explicitly and omits
 * `internal_notes`, so a staff note cannot reach a shopper even if someone
 * later serialises the whole object. The staff loader is a separate function
 * rather than a flag, for the same reason the catalog queries are split
 * (docs/SECURITY.md).
 */

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

/** Columns a customer may see. Note the absence of internalNotes. */
const customerOrderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  userId: orders.userId,
  status: orders.status,
  shippingAddressId: orders.shippingAddressId,
  subtotalBdt: orders.subtotalBdt,
  shippingFeeBdt: orders.shippingFeeBdt,
  discountBdt: orders.discountBdt,
  totalBdt: orders.totalBdt,
  amountDueNowBdt: orders.amountDueNowBdt,
  trackingReference: orders.trackingReference,
  placedAt: orders.placedAt,
};

async function loadRelated(orderId: string, shippingAddressId: string) {
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
      .where(eq(addresses.id, shippingAddressId))
      .limit(1),
    db.select().from(payments).where(eq(payments.orderId, orderId)),
  ]);

  return {
    items,
    history,
    address: address[0] ?? null,
    payments: paymentRows,
  };
}

/** Customer-facing order, without any staff-only field. */
async function loadCustomerOrder(orderId: string) {
  const [order] = await db
    .select(customerOrderColumns)
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  return { ...order, ...(await loadRelated(orderId, order.shippingAddressId)) };
}

/**
 * An order is visible to the shopper who placed it, or to staff. A guest order
 * is looked up separately, by order number and email.
 */
export async function getOrderForUser(
  actor: SessionUser | null,
  orderId: string,
) {
  const order = await loadCustomerOrder(orderId);
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
  return loadCustomerOrder(match.id);
}

/** Staff view: every column, including internal notes. */
export async function getOrderForStaff(orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  return { ...order, ...(await loadRelated(orderId, order.shippingAddressId)) };
}
