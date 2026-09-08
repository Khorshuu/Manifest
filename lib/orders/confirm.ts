import { and, eq } from "drizzle-orm";
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
 * In production this is driven by the gateway's webhook. It must be idempotent
 * on the provider reference: a replayed or duplicated call cannot confirm an
 * order twice (docs/SECURITY.md).
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
};

export async function confirmPayment(
  providerRef: string,
): Promise<ConfirmationResult> {
  const [payment] = await db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      status: payments.status,
      amountBdt: payments.amountBdt,
    })
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

    return {
      orderId: payment.orderId,
      status: order.status,
      alreadyConfirmed: true,
    };
  }

  const intent = await getPaymentProvider().capture(providerRef);

  if (intent.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed" })
      .where(eq(payments.id, payment.id));

    throw new PaymentConfirmationError("That payment was declined.");
  }

  const result = await db.transaction(async (tx) => {
    // Guarded on the current status, so two concurrent confirmations cannot
    // both write the transition.
    const updated = await tx
      .update(payments)
      .set({ status: "captured" })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "initiated")))
      .returning({ id: payments.id });

    if (updated.length === 0) {
      const [order] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, payment.orderId));

      return {
        orderId: payment.orderId,
        status: order.status,
        alreadyConfirmed: true,
      };
    }

    await tx
      .update(orders)
      .set({ status: "payment_confirmed" })
      .where(eq(orders.id, payment.orderId));

    await tx.insert(orderStatusHistory).values({
      orderId: payment.orderId,
      status: "payment_confirmed",
      note: `Payment captured (${providerRef}).`,
      // Null actor: the gateway drove this, not a member of staff.
      actorUserId: null,
    });

    // A replayed webhook reaches here at most once, because the payment update
    // above is guarded; the dedupe key in the outbox is the second guard.
    await queueOrderNotification(tx, payment.orderId, "payment_confirmed");

    return {
      orderId: payment.orderId,
      status: "payment_confirmed",
      alreadyConfirmed: false,
    };
  });

  deliverQueuedNotificationsInBackground();

  return result;
}
