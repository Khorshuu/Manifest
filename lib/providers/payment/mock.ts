import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  WebhookVerificationError,
  type CreatePaymentInput,
  type PaymentIntent,
  type PaymentMethod,
  type PaymentProvider,
  type RefundInput,
  type VerifiedPaymentEvent,
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

  /** Defaults to PAYMENT_WEBHOOK_SECRET; tests pass their own. */
  constructor(private readonly webhookSecret?: string) {}

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

  /**
   * Webhooks signed the way real gateways sign them: HMAC-SHA256 over
   * `<timestamp>.<raw body>` with a shared secret, and refused when the
   * timestamp is more than five minutes from now, so a captured request cannot
   * be replayed later.
   */
  async verifyWebhook(input: {
    rawBody: string;
    headers: Headers;
    now?: Date;
  }): Promise<VerifiedPaymentEvent> {
    const secret = this.webhookSecret ?? process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) throw new WebhookVerificationError("Webhook signing is not configured.");

    const timestamp = input.headers.get(MOCK_TIMESTAMP_HEADER) ?? "";
    const signature = input.headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    const seconds = Number(timestamp);
    const now = (input.now ?? new Date()).getTime() / 1000;

    if (!Number.isFinite(seconds) || Math.abs(now - seconds) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new WebhookVerificationError("That webhook is too old or has no timestamp.");
    }

    const expected = Buffer.from(signMockWebhook(input.rawBody, secret, seconds));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new WebhookVerificationError();
    }

    let body: { id?: unknown; type?: unknown; providerRef?: unknown; amountBdt?: unknown };
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new WebhookVerificationError("That webhook body is not JSON.");
    }
    if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 200) {
      throw new WebhookVerificationError("That webhook has no event id.");
    }

    const known = ["payment.captured", "payment.failed", "refund.completed"] as const;
    return {
      eventId: body.id,
      type: known.includes(body.type as (typeof known)[number])
        ? (body.type as (typeof known)[number])
        : "unknown",
      providerRef: typeof body.providerRef === "string" ? body.providerRef : null,
      amountBdt: Number.isInteger(body.amountBdt) ? (body.amountBdt as number) : null,
      payload: body,
    };
  }

  async retrieve(providerRef: string): Promise<PaymentIntent> {
    if (!providerRef.startsWith(PREFIX)) {
      throw new Error(`Unknown payment reference ${providerRef}.`);
    }
    // The mock never captures on its own; only a webhook or capture() does.
    return {
      providerRef,
      redirectUrl: null,
      status: providerRef.startsWith(DECLINED) ? "failed" : "initiated",
    };
  }

  /** Kept for existing tests; there is nothing to forget. */
  reset(): void {}
}

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
export const MOCK_TIMESTAMP_HEADER = "x-mock-timestamp";
const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The signature the mock expects, for tests and local tooling. */
export function signMockWebhook(rawBody: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `sha256=${digest}`;
}
