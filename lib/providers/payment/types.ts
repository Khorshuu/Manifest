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

export interface PaymentProvider {
  readonly name: string;
  /** Methods this provider can actually take, for the checkout UI. */
  supportedMethods(): PaymentMethod[];
  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;
  /** Confirms an intent — in production this is driven by a webhook. */
  capture(providerRef: string): Promise<PaymentIntent>;
  refund(input: RefundInput): Promise<{ providerRef: string }>;
}
