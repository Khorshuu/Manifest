import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { paymentEvents, payments } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { recordCapturedPayment } from "@/lib/orders/confirm";
import { getPaymentProvider } from "@/lib/providers/payment";

/**
 * Provider webhooks, processed once.
 *
 * 1. The provider named in the URL must be the configured one.
 * 2. Its signature and freshness are verified before anything is stored.
 * 3. The event is recorded under (provider, event id). A repeated delivery
 *    finds the row and does nothing.
 * 4. The row is claimed (`received`/`failed` → `processing`) by a guarded
 *    update, so two simultaneous deliveries cannot both process it.
 * 5. The effect goes through `recordCapturedPayment`, which is itself
 *    idempotent and guarded on the order's status.
 *
 * A processing failure marks the event `failed` and is rethrown, so the
 * provider receives an error and delivers again; that delivery can claim the
 * failed row and retry rather than being swallowed as a duplicate.
 */

export type WebhookOutcome = { result: "processed" | "ignored" | "duplicate" };

export async function handlePaymentWebhook(
  providerName: string,
  rawBody: string,
  headers: Headers,
  now?: Date,
): Promise<WebhookOutcome> {
  const provider = getPaymentProvider();
  if (provider.name !== providerName) throw new NotFoundError();

  const event = await provider.verifyWebhook({ rawBody, headers, now });

  await db
    .insert(paymentEvents)
    .values({
      provider: provider.name,
      eventId: event.eventId,
      eventType: event.type,
      providerRef: event.providerRef,
      amountBdt: event.amountBdt,
      payload: (event.payload ?? {}) as object,
    })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] });

  const [claimed] = await db
    .update(paymentEvents)
    .set({ status: "processing", attempts: sql`${paymentEvents.attempts} + 1` })
    .where(
      and(
        eq(paymentEvents.provider, provider.name),
        eq(paymentEvents.eventId, event.eventId),
        inArray(paymentEvents.status, ["received", "failed"]),
      ),
    )
    .returning({ id: paymentEvents.id });

  if (!claimed) return { result: "duplicate" };

  try {
    let result: "processed" | "ignored" = "ignored";

    if (event.type === "payment.captured") {
      if (!event.providerRef) throw new ValidationError("That event names no payment.");
      await recordCapturedPayment(event.providerRef, {
        amountBdt: event.amountBdt,
        source: `webhook ${provider.name} ${event.eventId}`,
      });
      result = "processed";
    } else if (event.type === "payment.failed") {
      if (!event.providerRef) throw new ValidationError("That event names no payment.");
      await db
        .update(payments)
        .set({ status: "failed" })
        .where(and(eq(payments.providerRef, event.providerRef), eq(payments.status, "initiated")));
      result = "processed";
    }
    // "refund.completed" and unknown types are recorded and ignored: refunds
    // are recorded by staff when they make them (DECISIONS.md D-015).

    await db
      .update(paymentEvents)
      .set({ status: result, processedAt: new Date(), error: null })
      .where(eq(paymentEvents.id, claimed.id));

    return { result };
  } catch (error) {
    await db
      .update(paymentEvents)
      .set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      .where(eq(paymentEvents.id, claimed.id));
    throw error;
  }
}
