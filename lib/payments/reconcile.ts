import { and, asc, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { paymentEvents, payments } from "@/db/schema";
import { recordCapturedPayment } from "@/lib/orders/confirm";
import { getPaymentProvider } from "@/lib/providers/payment";

/**
 * Reconciliation: what the provider knows that a webhook failed to tell us.
 *
 * Webhooks get lost. Payments still `initiated` after a while are looked up
 * through the provider's API (when it has one) and recorded through the same
 * guarded path a webhook uses. Events stuck in `processing` — the process died
 * mid-way — are marked failed so the next delivery can claim them.
 */

export type ReconciliationReport = {
  checked: number;
  captured: number;
  failed: number;
  errors: number;
  releasedStuckEvents: number;
};

export async function reconcilePayments(
  options: { olderThanMinutes?: number; limit?: number; now?: Date } = {},
): Promise<ReconciliationReport> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMinutes ?? 10) * 60_000);
  const report: ReconciliationReport = { checked: 0, captured: 0, failed: 0, errors: 0, releasedStuckEvents: 0 };

  const stuck = await db
    .update(paymentEvents)
    .set({ status: "failed", error: "Processing did not finish; left for the next delivery." })
    .where(and(eq(paymentEvents.status, "processing"), lt(paymentEvents.receivedAt, cutoff)))
    .returning({ id: paymentEvents.id });
  report.releasedStuckEvents = stuck.length;

  const provider = getPaymentProvider();
  if (!provider.retrieve) return report;

  const pending = await db
    .select({ id: payments.id, providerRef: payments.providerRef })
    .from(payments)
    .where(
      and(
        eq(payments.status, "initiated"),
        eq(payments.provider, provider.name),
        ne(payments.kind, "refund"),
        isNotNull(payments.providerRef),
        lt(payments.createdAt, cutoff),
      ),
    )
    .orderBy(asc(payments.createdAt))
    .limit(options.limit ?? 50);

  for (const row of pending) {
    report.checked += 1;
    try {
      const intent = await provider.retrieve(row.providerRef!);
      if (intent.status === "captured") {
        await recordCapturedPayment(row.providerRef!, { source: "reconciliation" });
        report.captured += 1;
      } else if (intent.status === "failed") {
        await db
          .update(payments)
          .set({ status: "failed" })
          .where(and(eq(payments.id, row.id), eq(payments.status, sql`'initiated'`)));
        report.failed += 1;
      }
    } catch {
      report.errors += 1;
    }
  }

  return report;
}
