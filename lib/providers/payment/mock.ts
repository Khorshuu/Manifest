import { createHash, randomUUID } from "node:crypto";
import type {
  CreatePaymentInput,
  PaymentIntent,
  PaymentMethod,
  PaymentProvider,
  RefundInput,
} from "./types";

/**
 * Development and test payment provider.
 *
 * Behaves like a real gateway in the ways that matter: it is idempotent on the
 * key it is given, it can be made to fail on demand, and capture is a separate
 * step from creating the intent. It never touches a network.
 *
 * It holds no state. An earlier version kept intents in a Map inside the
 * process, so an intent created by one server instance could not be captured
 * by another, and none survived a restart. Everything the mock needs is now in
 * the reference itself — derived from the idempotency key, and marked when the
 * attempt is to be declined — while the durable record of the payment is the
 * `payments` row, as it will be for a real gateway.
 */
const PREFIX = "mock_";
const DECLINED = "mock_declined_";

function referenceFor(idempotencyKey: string, declined: boolean): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${declined ? DECLINED : PREFIX}${digest}`;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  supportedMethods(): PaymentMethod[] {
    return ["card", "bkash", "nagad", "rocket", "bank_transfer", "cod"];
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    if (input.amountBdt <= 0) {
      throw new Error("A payment amount must be greater than zero.");
    }

    // A deterministic hook so tests can exercise the failure path without
    // reaching for mocks: any order whose email opts in is declined.
    const declined = input.customerEmail.includes("+decline");

    return {
      // Same key, same reference: a retried request finds the same intent.
      providerRef: referenceFor(input.idempotencyKey, declined),
      // Cash on delivery has nothing to redirect to.
      redirectUrl:
        input.method === "cod"
          ? null
          : `/checkout/mock-gateway?ref=${input.orderNumber}`,
      status: declined ? "failed" : "initiated",
    };
  }

  async capture(providerRef: string): Promise<PaymentIntent> {
    if (!providerRef.startsWith(PREFIX)) {
      throw new Error(`Unknown payment reference ${providerRef}.`);
    }

    return {
      providerRef,
      redirectUrl: null,
      status: providerRef.startsWith(DECLINED) ? "failed" : "captured",
    };
  }

  async refund(input: RefundInput): Promise<{ providerRef: string }> {
    if (!input.providerRef.startsWith(PREFIX)) {
      throw new Error(`Unknown payment reference ${input.providerRef}.`);
    }
    return { providerRef: `mock_refund_${randomUUID()}` };
  }

  /** Kept for existing tests; there is nothing to forget. */
  reset(): void {}
}
