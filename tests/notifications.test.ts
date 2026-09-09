/**
 * Order notifications.
 *
 * The rules with consequences: a customer is told once and only once about an
 * event, a message is only ever written for a committed order, and nothing
 * staff wrote for themselves reaches the customer's inbox.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  notifications,
  productVariants,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  composeOrderMessage,
  countOutboxByStatus,
  deliverQueuedNotifications,
  isNotifiedStatus,
  listOutbox,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFIED_STATUSES,
  setBackgroundDeliveryForTesting,
} from "@/lib/notifications";
import {
  advanceOrder,
  requestCancellation,
  resolveCancellationRequest,
  confirmPayment,
  placeOrder,
  refundOrder,
} from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import {
  DeliveryError,
  MockNotificationProvider,
  setNotificationProviderForTesting,
  type NotificationProvider,
} from "@/lib/providers/notification";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let notifier: MockNotificationProvider;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const shopper: SessionUser = {
  id: "",
  email: "shopper@example.com",
  role: "customer",
};

let addressId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
  // Delivery is driven explicitly here, so a queued row can be observed
  // before anything sends it.
  setBackgroundDeliveryForTesting(false);
}, 60_000);

afterAll(async () => {
  setBackgroundDeliveryForTesting(true);
  setPaymentProviderForTesting(undefined);
  setNotificationProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider());
  notifier = new MockNotificationProvider();
  setNotificationProviderForTesting(notifier);

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  shopper.id = rows.find((r) => r.email === "shopper@example.com")!.id;

  const [address] = await harness.db
    .insert(addresses)
    .values({
      userId: shopper.id,
      recipientName: "A Shopper",
      phone: "+8801700000000",
      addressLine1: "12 Example Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });

  addressId = address.id;
});

async function placeTestOrder(options: { guest?: boolean } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
  const product = await createProduct(staff, {
    title: `Product ${suffix}`,
    categoryId: category.id,
    status: "preorder_open",
  });

  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${suffix}`,
      priceBdt: 500_00,
      fulfillmentMode: "preorder",
      preorderCapacity: 10,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, 1);

  const placed = await placeOrder({
    cartId,
    userId: options.guest ? null : shopper.id,
    guestEmail: options.guest ? "guest@example.com" : shopper.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });

  return placed;
}

async function outboxFor(orderId: string) {
  return harness.db
    .select()
    .from(notifications)
    .where(eq(notifications.orderId, orderId));
}

describe("composing a message", () => {
  it("has a subject and a body for every status a customer is told about", () => {
    for (const status of NOTIFIED_STATUSES) {
      const message = composeOrderMessage(status, {
        orderNumber: "ORD-2026-000001",
        totalBdt: 100_000,
        amountDueNowBdt: 50_000,
      });

      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.body.length).toBeGreaterThan(0);
      // The order number is the one thing a customer needs to quote back.
      expect(message.subject + message.body).toContain("ORD-2026-000001");
    }
  });

  it("does not treat an unknown status as notifiable", () => {
    expect(isNotifiedStatus("payment_confirmed")).toBe(true);
    expect(isNotifiedStatus("nonsense")).toBe(false);
  });

  it("states the amount actually taken now, not only the total", () => {
    const message = composeOrderMessage("placed", {
      orderNumber: "ORD-2026-000002",
      totalBdt: 100_000,
      amountDueNowBdt: 25_000,
    });

    expect(message.body).toContain("250");
    expect(message.body).toContain("1,000");
  });
});

describe("queueing", () => {
  it("writes one message when an order is placed", async () => {
    const placed = await placeTestOrder();

    const rows = await outboxFor(placed.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].template).toBe("order.placed");
    expect(rows[0].recipient).toBe("shopper@example.com");
  });

  it("uses the guest address when there is no account", async () => {
    const placed = await placeTestOrder({ guest: true });

    const rows = await outboxFor(placed.orderId);
    expect(rows[0].recipient).toBe("guest@example.com");
  });

  it("adds a message for each status the order reaches", async () => {
    const placed = await placeTestOrder();
    await confirmPayment(
      (await harness.db.query.payments.findFirst())!.providerRef!,
    );
    await advanceOrder(staff, placed.orderId, "sourcing");

    const templates = (await outboxFor(placed.orderId)).map((r) => r.template);
    expect(templates).toContain("order.placed");
    expect(templates).toContain("order.payment_confirmed");
    expect(templates).toContain("order.sourcing");
  });

  /**
   * The rule CLAUDE.md section 7 names: a replayed webhook must not tell a
   * customer their payment succeeded twice.
   */
  it("tells the customer once when a payment confirmation is replayed", async () => {
    const placed = await placeTestOrder();
    const payment = await harness.db.query.payments.findFirst();

    await confirmPayment(payment!.providerRef!);
    await confirmPayment(payment!.providerRef!);
    await confirmPayment(payment!.providerRef!);

    const confirmations = (await outboxFor(placed.orderId)).filter(
      (row) => row.template === "order.payment_confirmed",
    );

    expect(confirmations).toHaveLength(1);
  });

  it("tells the customer when they cancel their own order", async () => {
    const placed = await placeTestOrder();
    // The shopper asks; staff approve. Only the approval is a cancellation,
    // so only the approval tells the customer their order has ended.
    await requestCancellation(shopper, placed.orderId, "Changed my mind");
    await resolveCancellationRequest(staff, placed.orderId, "approve");

    const templates = (await outboxFor(placed.orderId)).map((r) => r.template);
    expect(templates).toContain("order.cancelled");
  });

  it("tells the customer about a refund without quoting the staff reason", async () => {
    const placed = await placeTestOrder();
    await refundOrder(staff, placed.orderId, "Supplier failed us; goodwill refund");

    const [refund] = (await outboxFor(placed.orderId)).filter(
      (row) => row.template === "order.refunded",
    );

    expect(refund).toBeDefined();
    expect(refund.body).not.toContain("goodwill");
    expect(refund.body).not.toContain("Supplier");
  });
});

describe("delivering", () => {
  it("sends queued messages and records the provider id", async () => {
    const placed = await placeTestOrder();

    const report = await deliverQueuedNotifications();
    expect(report.sent).toBeGreaterThanOrEqual(1);

    const [row] = await outboxFor(placed.orderId);
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toMatch(/^mock_/);
    expect(row.sentAt).not.toBeNull();
    expect(notifier.sent.map((m) => m.recipient)).toContain(
      "shopper@example.com",
    );
  });

  it("sends nothing twice", async () => {
    await placeTestOrder();

    await deliverQueuedNotifications();
    const second = await deliverQueuedNotifications();

    expect(second.attempted).toBe(0);
  });

  /** A provider outage is recorded on the row, not thrown at the caller. */
  it("records a failure instead of losing the message", async () => {
    const failing: NotificationProvider = {
      async send() {
        throw new DeliveryError("The provider is unreachable.");
      },
    };
    setNotificationProviderForTesting(failing);

    const placed = await placeTestOrder();
    const report = await deliverQueuedNotifications();

    expect(report.failed).toBe(1);

    const [row] = await outboxFor(placed.orderId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The provider is unreachable.");
    expect(row.attempts).toBe(1);
  });

  /**
   * The reason the scheduled sweep exists: an outage should heal on the next
   * run rather than waiting for someone to notice and press a button.
   */
  it("retries a failed message on the next drain", async () => {
    let reachable = false;
    setNotificationProviderForTesting({
      async send() {
        if (!reachable) throw new DeliveryError("The provider is unreachable.");
        return { providerMessageId: "recovered" };
      },
    });

    const placed = await placeTestOrder();
    expect((await deliverQueuedNotifications()).failed).toBe(1);

    reachable = true;
    expect((await deliverQueuedNotifications()).sent).toBe(1);

    const [row] = await outboxFor(placed.orderId);
    expect(row.status).toBe("sent");
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(2);
  });

  /** A permanently bad address must not be retried forever. */
  it("gives up after the attempt limit", async () => {
    setNotificationProviderForTesting({
      async send() {
        throw new DeliveryError("No such address.");
      },
    });

    const placed = await placeTestOrder();

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await deliverQueuedNotifications();
    }

    const [row] = await outboxFor(placed.orderId);
    expect(row.attempts).toBe(MAX_DELIVERY_ATTEMPTS);

    // Nothing left to attempt: the row is still there, still failed, and no
    // longer picked up.
    expect((await deliverQueuedNotifications()).attempted).toBe(0);
    expect(row.status).toBe("failed");
  });

  it("never picks up a message that was already sent", async () => {
    await placeTestOrder();
    await deliverQueuedNotifications();

    expect((await deliverQueuedNotifications()).attempted).toBe(0);
  });
});

describe("the outbox as staff see it", () => {
  it("lists real rows with their order number", async () => {
    const placed = await placeTestOrder();

    const rows = await listOutbox(staff);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].orderNumber).toBe(placed.orderNumber);
  });

  it("counts by status from the table rather than guessing", async () => {
    await placeTestOrder();

    expect(await countOutboxByStatus(staff)).toEqual({
      queued: 1,
      sent: 0,
      failed: 0,
    });

    await deliverQueuedNotifications();

    expect(await countOutboxByStatus(staff)).toEqual({
      queued: 0,
      sent: 1,
      failed: 0,
    });
  });

  /** Every customer's contact address is in here. */
  it("refuses a customer", async () => {
    await placeTestOrder();

    await expect(listOutbox(shopper)).rejects.toThrow(AuthorizationError);
    await expect(countOutboxByStatus(shopper)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("refuses an anonymous caller", async () => {
    await expect(listOutbox(null)).rejects.toThrow();
  });
});
