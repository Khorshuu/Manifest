import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  addresses,
  orderItems,
  orderStatusHistory,
  orders,
  productVariants,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { getShippingProvider } from "@/lib/providers/shipping";

/**
 * Booking a delivery and recording its tracking reference.
 *
 * The reference lives on the order so a shopper can see it, and every change
 * to it is audited — it is the thing a customer will quote when something has
 * gone wrong.
 */

export class ShipmentError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ShipmentError";
  }
}

export async function bookShipment(
  actor: SessionUser | null,
  orderId: string,
) {
  const staff = requirePermission(actor, "orders.manage");

  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      trackingReference: orders.trackingReference,
      shippingAddressId: orders.shippingAddressId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new ShipmentError("That order no longer exists.");

  // Already booked: return what exists rather than booking a second delivery.
  if (order.trackingReference) {
    return { trackingReference: order.trackingReference, reused: true };
  }

  if (order.status === "cancelled" || order.status === "refunded") {
    throw new ShipmentError("That order is no longer going anywhere.");
  }

  const [address] = await db
    .select()
    .from(addresses)
    .where(eq(addresses.id, order.shippingAddressId));

  if (!address) throw new ShipmentError("That order has no delivery address.");

  // Weight comes from the variants actually ordered, so a carrier that prices
  // by weight is given a real number rather than a guess.
  const items = await db
    .select({
      quantity: orderItems.quantity,
      weightGrams: productVariants.weightGrams,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(eq(orderItems.orderId, orderId));

  const weightGrams = items.reduce(
    (total, item) => total + (item.weightGrams ?? 0) * item.quantity,
    0,
  );

  const provider = getShippingProvider();
  const shipment = await provider.createShipment({
    orderId: order.id,
    orderNumber: order.orderNumber,
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: address.city,
    district: address.district,
    postalCode: address.postalCode,
    weightGrams,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ trackingReference: shipment.trackingReference })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: order.status,
      note: `Delivery booked with ${shipment.carrier}, tracking ${shipment.trackingReference}.`,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.status_changed",
        entityType: "order",
        entityId: orderId,
        before: { trackingReference: null },
        after: { trackingReference: shipment.trackingReference },
      },
      tx,
    );
  });

  return { trackingReference: shipment.trackingReference, reused: false };
}

/**
 * Records a tracking reference entered by hand — the common case while there
 * is no courier integration, since staff book deliveries themselves.
 */
export async function setTrackingReference(
  actor: SessionUser | null,
  orderId: string,
  trackingReference: string,
) {
  const staff = requirePermission(actor, "orders.manage");

  const trimmed = trackingReference.trim();
  if (trimmed.length === 0) {
    throw new ShipmentError("Enter a tracking reference.");
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        status: orders.status,
        trackingReference: orders.trackingReference,
      })
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!before) throw new ShipmentError("That order no longer exists.");

    await tx
      .update(orders)
      .set({ trackingReference: trimmed })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: before.status,
      note: `Tracking reference set to ${trimmed}.`,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.status_changed",
        entityType: "order",
        entityId: orderId,
        before: { trackingReference: before.trackingReference },
        after: { trackingReference: trimmed },
      },
      tx,
    );

    return { trackingReference: trimmed };
  });
}

/** Live tracking for an order, when it has a reference to look up. */
export async function trackOrder(orderId: string) {
  const [order] = await db
    .select({ trackingReference: orders.trackingReference })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order?.trackingReference) return null;

  return getShippingProvider().track(order.trackingReference);
}

/** Staff-only note against an order, never shown to the shopper. */
export async function addInternalNote(
  actor: SessionUser | null,
  orderId: string,
  note: string,
) {
  const staff = requirePermission(actor, "orders.manage");

  const trimmed = note.trim();
  if (trimmed.length === 0) throw new ShipmentError("Enter a note.");

  const [before] = await db
    .select({ internalNotes: orders.internalNotes })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!before) throw new ShipmentError("That order no longer exists.");

  const stamped = `${new Date().toISOString()} — ${staff.email}: ${trimmed}`;
  const combined = before.internalNotes
    ? `${before.internalNotes}\n${stamped}`
    : stamped;

  await db
    .update(orders)
    .set({ internalNotes: combined })
    .where(eq(orders.id, orderId));

  return { internalNotes: combined };
}
