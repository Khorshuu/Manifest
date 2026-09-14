import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  orderStatusHistory,
  orders,
  payments,
} from "@/db/schema";
import {
  deliverQueuedNotificationsInBackground,
  queueOrderNotification,
} from "@/lib/notifications";
import { getPaymentProvider } from "@/lib/providers/payment";

/**
 * Payment confirmation.
 *
 * Money arriving is recorded in exactly one place, `recordCapturedPayment`,
 * whatever told us about it: a signed provider webhook, reconciliation against
 * the provider's API, or — in development only — the mock capture below. It
 * is idempotent on the payment row and guarded on the order's status, so a
 * replayed or duplicated event cannot confirm an order twice
 * (docs/SECURITY.md).
 */

export class PaymentConfirmationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "PaymentConfirmationError";
  }
}

export type ConfirmationResult = {
  orderId: string;
  status: string;
  /** True when the payment was already captured before this call. */
  alreadyConfirmed: boolean;
  /**
   * True when the money arrived for an order that had already been cancelled
   * — typically its unpaid hold expired first. The order is not reinstated;
   * staff refund the payment.
   */
  arrivedAfterCancellation?: boolean;
};

/** Statuses from which a provider's "captured" may still be recorded. */
const CAPTURABLE = ["initiated", "authorized", "failed"];

export async function recordCapturedPayment(
  providerRef: string,
  options: { amountBdt?: number | null; source: string },
): Promise<ConfirmationResult> {
  const result = await db.transaction(async (tx) => {
    const [payment] = await tx
      .select({
        id: payments.id,
        orderId: payments.orderId,
        kind: payments.kind,
        status: payments.status,
        amountBdt: payments.amountBdt,
      })
      .from(payments)
      .where(eq(payments.providerRef, providerRef))
      .limit(1)
      // Held until commit: concurrent deliveries of one payment queue here.
      .for("update");

    if (!payment || payment.kind === "refund") {
      throw new PaymentConfirmationError("That payment reference is unknown.");
    }

    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .for("update");

    if (payment.status === "captured") {
      return { orderId: order.id, status: order.status, alreadyConfirmed: true };
    }

    if (!CAPTURABLE.includes(payment.status)) {
      throw new PaymentConfirmationError(`A ${payment.status} payment cannot be captured.`);
    }

    // The provider's figure has to be the one we asked for. A mismatch is not
    // "close enough": it is either a bug or tampering, and staff decide.
    if (
      options.amountBdt !== undefined &&
      options.amountBdt !== null &&
      options.amountBdt !== payment.amountBdt
    ) {
      throw new PaymentConfirmationError(
        "The captured amount does not match what this payment asked for.",
      );
    }

    await tx
      .update(payments)
      .set({ status: "captured" })
      .where(and(eq(payments.id, payment.id), inArray(payments.status, CAPTURABLE)));

    if (order.status === "placed" && payment.kind !== "balance") {
      await tx.update(orders).set({ status: "payment_confirmed" }).where(eq(orders.id, order.id));

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        status: "payment_confirmed",
        note: `Payment captured (${providerRef}).`,
        // Null actor: the provider drove this, not a member of staff.
        actorUserId: null,
      });

      await queueOrderNotification(tx, order.id, "payment_confirmed");

      return { orderId: order.id, status: "payment_confirmed", alreadyConfirmed: false };
    }

    const late = order.status === "cancelled" || order.status === "refunded";

    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      // The stage does not move; the row records the money.
      status: order.status,
      note: late
        ? `Payment ${providerRef} was captured after the order was ${order.status}. Refund it to the customer.`
        : `Payment captured (${providerRef}) via ${options.source}.`,
      actorUserId: null,
    });

    return {
      orderId: order.id,
      status: order.status,
      alreadyConfirmed: false,
      ...(late ? { arrivedAfterCancellation: true } : {}),
    };
  });

  deliverQueuedNotificationsInBackground();

  return result;
}

/**
 * Captures through the provider, then records it. Used by the mock gateway in
 * development and by tests; a real gateway reports captures by webhook.
 */
export async function confirmPayment(
  providerRef: string,
): Promise<ConfirmationResult> {
  const [payment] = await db
    .select({ id: payments.id, orderId: payments.orderId, status: payments.status })
    .from(payments)
    .where(eq(payments.providerRef, providerRef))
    .limit(1);

  if (!payment) {
    throw new PaymentConfirmationError("That payment reference is unknown.");
  }

  if (payment.status === "captured") {
    const [order] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, payment.orderId));

    return { orderId: payment.orderId, status: order.status, alreadyConfirmed: true };
  }

  const intent = await getPaymentProvider().capture(providerRef);

  if (intent.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed" })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "initiated")));

    throw new PaymentConfirmationError("That payment was declined.");
  }

  return recordCapturedPayment(providerRef, { source: "capture" });
}
