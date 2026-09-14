/**
 * Payment webhooks: only a signed, fresh event from the configured provider
 * changes anything, and the same event changes it once.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addresses,
  categories,
  orderStatusHistory,
  orders,
  paymentEvents,
  payments,
  products,
  productVariants,
  users,
} from "@/db/schema";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { advanceOrder, confirmPayment, placeOrder, PaymentConfirmationError } from "@/lib/orders";
import { handlePaymentWebhook } from "@/lib/payments/webhooks";
import { reconcilePayments } from "@/lib/payments/reconcile";
import {
  MOCK_SIGNATURE_HEADER,
  MOCK_TIMESTAMP_HEADER,
  MockPaymentProvider,
  setPaymentProviderForTesting,
  signMockWebhook,
  WebhookVerificationError,
} from "@/lib/providers/payment";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import { NotFoundError } from "@/lib/errors";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

const SECRET = "test-webhook-secret-that-is-long-enough-000";
let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let customerId = "";
let addressId = "";
let staff: SessionUser;

beforeAll(async () => {
  harness = await createTestDatabase();
  setBackgroundDeliveryForTesting(false);
}, 60_000);

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  setBackgroundDeliveryForTesting(true);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider(SECRET));

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
    ])
    .returning({ id: users.id, role: users.role, email: users.email });
  customerId = rows.find((row) => row.role === "customer")!.id;
  const staffRow = rows.find((row) => row.role === "staff_admin")!;
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };

  const [address] = await harness.db
    .insert(addresses)
    .values({ userId: customerId, recipientName: "A", phone: "+8801700000000", addressLine1: "1 Road", city: "Dhaka", district: "Dhaka" })
    .returning({ id: addresses.id });
  addressId = address.id;
});

afterEach(() => vi.unstubAllEnvs());

async function placedOrder() {
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: `c-${Math.random()}` }).returning({ id: categories.id });
  const [product] = await harness.db
    .insert(products)
    .values({ categoryId: category.id, title: "Hooked", slug: `hooked-${Math.random()}`, status: "preorder_open" })
    .returning({ id: products.id });
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId: product.id, sku: `HOOK-${Math.random()}`, priceBdt: 1_000_00, fulfillmentMode: "preorder", preorderCapacity: 5, preorderClosesAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: productVariants.id });

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, 1);
  const placed = await placeOrder({
    cartId,
    userId: customerId,
    guestEmail: "shopper@example.com",
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `hook-${Math.random()}`,
  });
  const [payment] = await harness.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
  return { placed, payment, variantId: variant.id };
}

function signed(body: object, options: { secret?: string; at?: Date } = {}) {
  const raw = JSON.stringify(body);
  const seconds = Math.floor((options.at ?? new Date()).getTime() / 1000);
  const headers = new Headers({
    [MOCK_TIMESTAMP_HEADER]: String(seconds),
    [MOCK_SIGNATURE_HEADER]: signMockWebhook(raw, options.secret ?? SECRET, seconds),
  });
  return { raw, headers };
}

async function deliver(body: object, options: { secret?: string; at?: Date; provider?: string } = {}) {
  const { raw, headers } = signed(body, options);
  return handlePaymentWebhook(options.provider ?? "mock", raw, headers);
}

async function orderStatus(orderId: string) {
  const [row] = await harness.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return row.status;
}

describe("a signed capture event", () => {
  it("confirms the order and records the event as processed", async () => {
    const { placed, payment } = await placedOrder();

    const outcome = await deliver({ id: "evt_1", type: "payment.captured", providerRef: payment.providerRef, amountBdt: payment.amountBdt });

    expect(outcome.result).toBe("processed");
    expect(await orderStatus(placed.orderId)).toBe("payment_confirmed");
    const [event] = await harness.db.select().from(paymentEvents);
    expect(event).toMatchObject({ eventId: "evt_1", status: "processed", attempts: 1 });
  });

  it("changes nothing the second time the same event arrives", async () => {
    const { placed, payment } = await placedOrder();
    const body = { id: "evt_dup", type: "payment.captured", providerRef: payment.providerRef, amountBdt: payment.amountBdt };

    await deliver(body);
    const second = await deliver(body);

    expect(second.result).toBe("duplicate");
    const confirmations = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, placed.orderId), eq(orderStatusHistory.status, "payment_confirmed")));
    expect(confirmations).toHaveLength(1);
    await expect(harness.db.select().from(paymentEvents)).resolves.toHaveLength(1);
  });
});

describe("events that must not be believed", () => {
  it("refuses a wrong signature and stores nothing", async () => {
    const { placed, payment } = await placedOrder();

    await expect(
      deliver({ id: "evt_forged", type: "payment.captured", providerRef: payment.providerRef }, { secret: "not-the-real-secret-not-the-real-secret" }),
    ).rejects.toThrow(WebhookVerificationError);

    expect(await orderStatus(placed.orderId)).toBe("placed");
    await expect(harness.db.select().from(paymentEvents)).resolves.toHaveLength(0);
  });

  it("refuses a correctly signed event that is too old to be fresh", async () => {
    const { payment } = await placedOrder();
    await expect(
      deliver({ id: "evt_old", type: "payment.captured", providerRef: payment.providerRef }, { at: new Date(Date.now() - 10 * 60_000) }),
    ).rejects.toThrow(/too old/);
  });

  it("answers not found for a provider that is not configured", async () => {
    const { payment } = await placedOrder();
    await expect(
      deliver({ id: "evt_other", type: "payment.captured", providerRef: payment.providerRef }, { provider: "sslcommerz" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses every webhook when no secret is configured", async () => {
    setPaymentProviderForTesting(new MockPaymentProvider());
    vi.stubEnv("PAYMENT_WEBHOOK_SECRET", "");
    const { payment } = await placedOrder();
    await expect(deliver({ id: "evt_nosecret", type: "payment.captured", providerRef: payment.providerRef })).rejects.toThrow(
      /not configured/,
    );
  });
});

describe("processing failures", () => {
  it("does not confirm a capture for the wrong amount, and retries on redelivery", async () => {
    const { placed, payment } = await placedOrder();
    const wrong = { id: "evt_amount", type: "payment.captured", providerRef: payment.providerRef, amountBdt: payment.amountBdt - 1 };

    await expect(deliver(wrong)).rejects.toThrow(PaymentConfirmationError);
    expect(await orderStatus(placed.orderId)).toBe("placed");

    // The same event again is retried, not dismissed as a duplicate.
    await expect(deliver(wrong)).rejects.toThrow(PaymentConfirmationError);
    const [event] = await harness.db.select().from(paymentEvents);
    expect(event).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("marks the payment failed on a failure event", async () => {
    const { payment } = await placedOrder();
    await deliver({ id: "evt_fail", type: "payment.failed", providerRef: payment.providerRef });
    const [row] = await harness.db.select({ status: payments.status }).from(payments).where(eq(payments.id, payment.id));
    expect(row.status).toBe("failed");
  });

  it("records money that arrives after cancellation without reinstating the order", async () => {
    const { placed, payment } = await placedOrder();
    await advanceOrder(staff, placed.orderId, "cancelled", "hold expired");

    await deliver({ id: "evt_late", type: "payment.captured", providerRef: payment.providerRef, amountBdt: payment.amountBdt });

    expect(await orderStatus(placed.orderId)).toBe("cancelled");
    const [row] = await harness.db.select({ status: payments.status }).from(payments).where(eq(payments.id, payment.id));
    expect(row.status).toBe("captured");
    const notes = await harness.db.select({ note: orderStatusHistory.note }).from(orderStatusHistory).where(eq(orderStatusHistory.orderId, placed.orderId));
    expect(notes.some((entry) => /after the order was cancelled.*Refund/i.test(entry.note ?? ""))).toBe(true);
  });

  it("releases an event stuck in processing so it can be retried", async () => {
    await harness.db.insert(paymentEvents).values({
      provider: "mock",
      eventId: "evt_stuck",
      eventType: "payment.captured",
      payload: {},
      status: "processing",
      receivedAt: new Date(Date.now() - 60 * 60_000),
    });

    const report = await reconcilePayments();

    expect(report.releasedStuckEvents).toBe(1);
    const [event] = await harness.db.select().from(paymentEvents);
    expect(event.status).toBe("failed");
  });
});

describe("payment state survives a restart", () => {
  it("confirms with a provider instance that never saw the payment created", async () => {
    const { placed, payment } = await placedOrder();

    // A different process, or the same one after a restart.
    setPaymentProviderForTesting(new MockPaymentProvider(SECRET));

    await expect(confirmPayment(payment.providerRef!)).resolves.toMatchObject({ status: "payment_confirmed" });
    expect(await orderStatus(placed.orderId)).toBe("payment_confirmed");
  });
});

describe("the development confirmation route", () => {
  it("is not found in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { POST } = await import("@/app/api/checkout/confirm/route");
    const response = await POST(
      new Request("http://localhost/api/checkout/confirm", { method: "POST", body: JSON.stringify({ providerRef: "mock_x" }) }),
    );
    expect(response.status).toBe(404);
  });
});
