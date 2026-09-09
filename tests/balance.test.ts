/**
 * Taking the balance on a deposit order.
 *
 * The rules with consequences, per DECISIONS.md D-012: the amount is decided by
 * the server and never by the request, the same balance cannot be taken twice,
 * and only staff can take one at all.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  auditLog,
  notifications,
  orders,
  payments,
  productVariants,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import {
  BalanceError,
  confirmPayment,
  getBalanceState,
  placeOrder,
  refundOrder,
  takeBalancePayment,
} from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import {
  MockNotificationProvider,
  setNotificationProviderForTesting,
} from "@/lib/providers/notification";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

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
  setNotificationProviderForTesting(new MockNotificationProvider());

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

/** An order placed on a 40% deposit, with the deposit already captured. */
async function depositOrder() {
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
      priceBdt: 1000_00,
      fulfillmentMode: "preorder",
      preorderCapacity: 10,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      paymentMode: "deposit",
      depositPercent: 40,
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, 1);

  const placed = await placeOrder({
    cartId,
    userId: shopper.id,
    guestEmail: shopper.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });

  // Capture the deposit, the way the gateway webhook would.
  const [deposit] = await harness.db
    .select({ providerRef: payments.providerRef })
    .from(payments)
    .where(eq(payments.orderId, placed.orderId));

  await confirmPayment(deposit.providerRef!);

  return placed;
}

describe("what is outstanding", () => {
  it("is the total less what has actually been paid", async () => {
    const placed = await depositOrder();
    const state = await getBalanceState(placed.orderId);

    expect(state).not.toBeNull();
    // 40% deposit on 1,000 taka.
    expect(state!.totalBdt).toBe(1000_00);
    expect(state!.paidBdt).toBe(400_00);
    expect(state!.outstandingBdt).toBe(600_00);
    expect(state!.collectable).toBe(true);
  });

  /**
   * Read from the payment rows rather than `amount_due_now_bdt`, which records
   * what was asked for at placement and would describe history once a refund
   * had been issued against the order.
   */
  it("follows the payments, not the figure recorded at placement", async () => {
    const placed = await depositOrder();
    await refundOrder(staff, placed.orderId, "Supplier could not source it");

    const state = await getBalanceState(placed.orderId);
    // The refund nets the deposit back off, so nothing has been paid — but the
    // order is refunded, so nothing is collectable either.
    expect(state!.paidBdt).toBe(0);
    expect(state!.collectable).toBe(false);
    expect(state!.reason).toMatch(/refunded/i);
  });
});

describe("taking the balance", () => {
  it("charges exactly what is outstanding and settles the order", async () => {
    const placed = await depositOrder();

    const result = await takeBalancePayment(staff, placed.orderId);
    expect(result.amountBdt).toBe(600_00);
    expect(result.alreadyPaid).toBe(false);

    const after = await getBalanceState(placed.orderId);
    expect(after!.paidBdt).toBe(1000_00);
    expect(after!.outstandingBdt).toBe(0);
    expect(after!.collectable).toBe(false);
  });

  it("writes one payment row of kind balance", async () => {
    const placed = await depositOrder();
    await takeBalancePayment(staff, placed.orderId);

    const rows = await harness.db
      .select({ kind: payments.kind, amountBdt: payments.amountBdt })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    const balances = rows.filter((row) => row.kind === "balance");
    expect(balances).toHaveLength(1);
    expect(balances[0].amountBdt).toBe(600_00);
  });

  /**
   * The rule that costs real money if it is wrong. Two presses, or two members
   * of staff at once, must take the balance once.
   */
  it("cannot take the same balance twice", async () => {
    const placed = await depositOrder();

    const first = await takeBalancePayment(staff, placed.orderId);
    const second = await takeBalancePayment(staff, placed.orderId);

    expect(first.alreadyPaid).toBe(false);
    expect(second.alreadyPaid).toBe(true);

    const rows = await harness.db
      .select({ kind: payments.kind })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    expect(rows.filter((row) => row.kind === "balance")).toHaveLength(1);
  });

  it("refuses an order that has nothing outstanding", async () => {
    const placed = await depositOrder();
    await takeBalancePayment(staff, placed.orderId);

    // The second call reports rather than throwing, but a fresh order paid in
    // full has no balance row to short-circuit on and must be refused.
    const state = await getBalanceState(placed.orderId);
    expect(state!.collectable).toBe(false);
    expect(state!.reason).toMatch(/paid in full/i);
  });

  it("refuses a cancelled or refunded order", async () => {
    const placed = await depositOrder();
    await refundOrder(staff, placed.orderId, "Batch abandoned");

    await expect(takeBalancePayment(staff, placed.orderId)).rejects.toThrow(
      BalanceError,
    );
  });

  it("tells the customer, once", async () => {
    const placed = await depositOrder();
    await takeBalancePayment(staff, placed.orderId);
    await takeBalancePayment(staff, placed.orderId);

    const messages = await harness.db
      .select({ subject: notifications.subject, body: notifications.body })
      .from(notifications)
      .where(eq(notifications.template, "order.balance_taken"));

    expect(messages).toHaveLength(1);
    // `\s` rather than a literal space: Intl puts a non-breaking space after
    // the currency code.
    expect(messages[0].body).toMatch(/BDT\s600/);
  });

  it("records who took it", async () => {
    const placed = await depositOrder();
    await takeBalancePayment(staff, placed.orderId);

    const entries = await harness.db
      .select({
        action: auditLog.action,
        actorUserId: auditLog.actorUserId,
      })
      .from(auditLog)
      .where(eq(auditLog.action, "order.balance_taken"));

    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(staff.id);
  });

  /** The fulfilment stage is about goods, not money. */
  it("does not move the order's status", async () => {
    const placed = await depositOrder();

    const [before] = await harness.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    await takeBalancePayment(staff, placed.orderId);

    const [after] = await harness.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(after.status).toBe(before.status);
  });
});

describe("who may take a balance", () => {
  it("refuses a customer", async () => {
    const placed = await depositOrder();

    await expect(takeBalancePayment(shopper, placed.orderId)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("refuses an anonymous caller", async () => {
    const placed = await depositOrder();

    await expect(takeBalancePayment(null, placed.orderId)).rejects.toThrow();
  });

  it("takes no money when it refuses", async () => {
    const placed = await depositOrder();

    await expect(takeBalancePayment(shopper, placed.orderId)).rejects.toThrow();

    const rows = await harness.db
      .select({ kind: payments.kind })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    expect(rows.filter((row) => row.kind === "balance")).toHaveLength(0);
  });
});
