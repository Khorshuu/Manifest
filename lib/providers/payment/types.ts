/**
 * Payment provider interface.
 *
 * Every call site talks to this, never to a gateway directly, so the app runs
 * end to end before SSLCommerz credentials exist (MASTER_PRODUCT_SPEC.md §6
 * and §7). Swapping in the real gateway changes only the implementation.
 */

export type PaymentMethod =
  | "card"
  | "bkash"
  | "nagad"
  | "rocket"
  | "bank_transfer"
  | "cod";

export const PAYMENT_METHODS: PaymentMethod[] = [
  "card",
  "bkash",
  "nagad",
  "rocket",
  "bank_transfer",
  "cod",
];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: "Card",
  bkash: "bKash",
  nagad: "Nagad",
  rocket: "Rocket",
  bank_transfer: "Bank transfer",
  cod: "Cash on delivery",
};

export type PaymentIntent = {
  /** The gateway's identifier for this attempt. */
  providerRef: string;
  /** Where to send the shopper, when the gateway hosts the payment page. */
  redirectUrl: string | null;
  status: "initiated" | "authorized" | "captured" | "failed";
};

export type CreatePaymentInput = {
  orderId: string;
  orderNumber: string;
  /** Always the server-computed amount. A client-supplied total is never used. */
  amountBdt: number;
  method: PaymentMethod;
  customerEmail: string;
  /** Passed through so a retry of the same request cannot charge twice. */
  idempotencyKey: string;
};

export type RefundInput = {
  providerRef: string;
  amountBdt: number;
  reason: string;
};

export type PaymentEventType =
  | "payment.captured"
  | "payment.failed"
  | "refund.completed";

/**
 * A webhook event whose signature has been checked. Only a provider's
 * `verifyWebhook` produces one, so nothing downstream acts on an unverified
 * body.
 */
export type VerifiedPaymentEvent = {
  /** The provider's own event id — the idempotency key for processing. */
  eventId: string;
  type: PaymentEventType | "unknown";
  providerRef: string | null;
  /** What the provider says moved, in paisa, when it says. */
  amountBdt: number | null;
  payload: unknown;
};

export class WebhookVerificationError extends Error {
  readonly status = 401;

  constructor(message = "That webhook could not be verified.") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface PaymentProvider {
  readonly name: string;
  /** Methods this provider can actually take, for the checkout UI. */
  supportedMethods(): PaymentMethod[];
  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;
  /** Confirms an intent — in production this is driven by a webhook. */
  capture(providerRef: string): Promise<PaymentIntent>;
  refund(input: RefundInput): Promise<{ providerRef: string }>;
  /**
   * Checks a webhook's signature and freshness, and turns its body into an
   * event. Throws WebhookVerificationError for anything it cannot prove came
   * from the provider.
   */
  verifyWebhook(input: {
    rawBody: string;
    headers: Headers;
    now?: Date;
  }): Promise<VerifiedPaymentEvent>;
  /**
   * The provider's current view of an attempt, for reconciliation. Optional:
   * a provider without a lookup API relies on webhooks alone.
   */
  retrieve?(providerRef: string): Promise<PaymentIntent>;
}
