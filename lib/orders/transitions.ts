import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  type OrderStatus,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { releaseCapacity } from "@/lib/preorder";
import { getPaymentProvider } from "@/lib/providers/payment";

/**
 * Order status transitions.
 *
 * Status only moves forward through the pipeline, or sideways into cancelled
 * or refunded. Nothing writes a status backward: a correction is a new history
 * row with a note, never a rewrite (docs/BUSINESS_LOGIC.md).
 */

const PIPELINE: OrderStatus[] = [
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
];

const TERMINAL: OrderStatus[] = ["cancelled", "refunded"];

export class TransitionError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

/** Statuses reachable from the current one. */
export function allowedTransitions(current: string): OrderStatus[] {
  if (TERMINAL.includes(current as OrderStatus)) return [];

  const index = PIPELINE.indexOf(current as OrderStatus);
  if (index === -1) return [];

  const next = PIPELINE[index + 1];
  const forward = next ? [next] : [];

  // Delivered is the end of the road for cancellation; a delivered order is
  // handled as a refund instead.
  return current === "delivered"
    ? ["refunded"]
    : [...forward, "cancelled", "refunded"];
}

export function canTransition(from: string, to: string): boolean {
  return allowedTransitions(from).includes(to as OrderStatus);
}

/**
 * Capacity is only released while the order still holds it. Once an order is
 * sourcing or beyond, the item has been bought in the US and the slot is
 * genuinely consumed.
 */
function stillHoldsCapacity(status: string): boolean {
  return status === "placed" || status === "payment_confirmed";
}

export async function advanceOrder(
  actor: SessionUser | null,
  orderId: string,
  to: OrderStatus,
  note?: string,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!order) throw new TransitionError("That order no longer exists.");

    if (!canTransition(order.status, to)) {
      throw new TransitionError(
        `An order that is ${order.status.replace(/_/g, " ")} cannot move to ${to.replace(/_/g, " ")}.`,
      );
    }

    // Cancelling gives the slots back, so someone else can take them.
    if (to === "cancelled" && stillHoldsCapacity(order.status)) {
      const items = await tx
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      for (const item of items) {
        await releaseCapacity(tx, item.variantId, item.quantity);
      }
    }

    await tx
      .update(orders)
      .set({ status: to })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: to,
      note: note ?? null,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.status_changed",
        entityType: "order",
        entityId: orderId,
        before: { status: order.status },
        after: { status: to },
      },
      tx,
    );

    return { orderId, status: to };
  });
}

/**
 * Refunds go through the payment provider and always produce a payment row of
 * kind 'refund' — never a silent adjustment on the order (docs/SECURITY.md).
 */
export async function refundOrder(
  actor: SessionUser | null,
  orderId: string,
  reason: string,
) {
  const staff = requireStaff(actor);

  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new TransitionError("That order no longer exists.");

  if (order.status === "refunded") {
    throw new TransitionError("That order has already been refunded.");
  }

  const captured = await db
    .select({
      id: payments.id,
      providerRef: payments.providerRef,
      amountBdt: payments.amountBdt,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId));

  const toRefund = captured.filter((payment) => payment.providerRef);

  const provider = getPaymentProvider();

  for (const payment of toRefund) {
    const result = await provider.refund({
      providerRef: payment.providerRef!,
      amountBdt: payment.amountBdt,
      reason,
    });

    await db.insert(payments).values({
      orderId,
      kind: "refund",
      provider: provider.name,
      providerRef: result.providerRef,
      // Recorded as a negative amount, so the sum of a customer's payment rows
      // is what they actually paid.
      amountBdt: -payment.amountBdt,
      status: "refunded",
    });
  }

  return db.transaction(async (tx) => {
    if (stillHoldsCapacity(order.status)) {
      const items = await tx
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      for (const item of items) {
        await releaseCapacity(tx, item.variantId, item.quantity);
      }
    }

    await tx
      .update(orders)
      .set({ status: "refunded" })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: "refunded",
      note: reason,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.refunded",
        entityType: "order",
        entityId: orderId,
        before: { status: order.status },
        after: { status: "refunded", reason },
      },
      tx,
    );

    return { orderId, status: "refunded" as const, refunded: toRefund.length };
  });
}

export class CancellationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CancellationError";
  }
}

/**
 * A shopper may cancel their own order while it has not been sourced. After
 * that the item has been bought in the US on their behalf, so it becomes a
 * refund decision for staff (MASTER_PRODUCT_SPEC.md §5.6).
 */
export async function cancelOwnOrder(
  actor: SessionUser | null,
  orderId: string,
) {
  if (!actor) throw new CancellationError("Sign in to cancel an order.");

  const [order] = await db
    .select({ id: orders.id, status: orders.status, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new CancellationError("That order no longer exists.");

  if (order.userId !== actor.id) {
    throw new CancellationError("That order is not yours.");
  }

  if (!stillHoldsCapacity(order.status)) {
    throw new CancellationError(
      "This order is already being sourced. Contact us and we will look at it with you.",
    );
  }

  return db.transaction(async (tx) => {
    const items = await tx
      .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    for (const item of items) {
      await releaseCapacity(tx, item.variantId, item.quantity);
    }

    await tx
      .update(orders)
      .set({ status: "cancelled" })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: "cancelled",
      note: "Cancelled by the shopper.",
      actorUserId: actor.id,
    });

    return { orderId, status: "cancelled" as const };
  });
}

/** Staff order pipeline, filterable by status. */
export async function listOrdersForStaff(
  actor: SessionUser | null,
  filter: { status?: OrderStatus } = {},
) {
  requireStaff(actor);

  const query = db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
      placedAt: orders.placedAt,
      guestEmail: orders.guestEmail,
      userId: orders.userId,
    })
    .from(orders)
    .orderBy(orders.placedAt);

  const rows = filter.status
    ? await query.where(eq(orders.status, filter.status))
    : await query;

  return rows;
}
