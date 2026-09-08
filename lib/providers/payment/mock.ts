import { randomUUID } from "node:crypto";
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
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  /** Keyed by idempotency key, so a retry returns the original intent. */
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly byRef = new Map<string, PaymentIntent>();

  supportedMethods(): PaymentMethod[] {
    return ["card", "bkash", "nagad", "rocket", "bank_transfer", "cod"];
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const existing = this.intents.get(input.idempotencyKey);
    if (existing) return existing;

    if (input.amountBdt <= 0) {
      throw new Error("A payment amount must be greater than zero.");
    }

    // A deterministic hook so tests can exercise the failure path without
    // reaching for mocks: any order whose email opts in is declined.
    const declined = input.customerEmail.includes("+decline");

    const intent: PaymentIntent = {
      providerRef: `mock_${randomUUID()}`,
      // Cash on delivery has nothing to redirect to.
      redirectUrl:
        input.method === "cod"
          ? null
          : `/checkout/mock-gateway?ref=${input.orderNumber}`,
      status: declined ? "failed" : "initiated",
    };

    this.intents.set(input.idempotencyKey, intent);
    this.byRef.set(intent.providerRef, intent);
    return intent;
  }

  async capture(providerRef: string): Promise<PaymentIntent> {
    const intent = this.byRef.get(providerRef);
    if (!intent) throw new Error(`Unknown payment reference ${providerRef}.`);

    if (intent.status === "failed") return intent;

    const captured: PaymentIntent = { ...intent, status: "captured" };
    this.byRef.set(providerRef, captured);
    return captured;
  }

  async refund(input: RefundInput): Promise<{ providerRef: string }> {
    if (!this.byRef.has(input.providerRef)) {
      throw new Error(`Unknown payment reference ${input.providerRef}.`);
    }
    return { providerRef: `mock_refund_${randomUUID()}` };
  }

  /** Test helper: forget everything recorded so far. */
  reset(): void {
    this.intents.clear();
    this.byRef.clear();
  }
}
