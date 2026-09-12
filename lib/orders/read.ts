import { and, desc, eq, inArray } from "drizzle-orm";
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

export type OrderSummaryLine = {
  titleSnapshot: string;
  optionSummarySnapshot: string | null;
  imageUrlSnapshot: string | null;
  quantity: number;
};

export type OrderSummary = Awaited<
  ReturnType<typeof listOrdersForUser>
>[number] & { items: OrderSummaryLine[] };

/**
 * The account's orders with enough of each one to recognise it — the
 * photograph, the product and the exact version bought (D-043). Everything
 * comes from the snapshot written when the order was placed, so an order still
 * reads correctly after the product it names has been renamed or archived.
 */
export async function listOrderSummariesForUser(
  userId: string,
  limit?: number,
): Promise<OrderSummary[]> {
  const rows = await listOrdersForUser(userId);
  const wanted = limit ? rows.slice(0, limit) : rows;
  if (wanted.length === 0) return [];

  const lines = await db
    .select({
      orderId: orderItems.orderId,
      titleSnapshot: orderItems.titleSnapshot,
      optionSummarySnapshot: orderItems.optionSummarySnapshot,
      imageUrlSnapshot: orderItems.imageUrlSnapshot,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        wanted.map((order) => order.id),
      ),
    );

  return wanted.map((order) => ({
    ...order,
    items: lines.filter((line) => line.orderId === order.id),
  }));
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
  dutyBdt: orders.dutyBdt,
  discountBdt: orders.discountBdt,
  totalBdt: orders.totalBdt,
  amountDueNowBdt: orders.amountDueNowBdt,
  trackingReference: orders.trackingReference,
  placedAt: orders.placedAt,
  /* Their own request, so they can see it is with us rather than ask twice.
     cancellationReason is theirs too, but the page has no use for reading
     their own words back at them. */
  cancellationRequestedAt: orders.cancellationRequestedAt,
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
