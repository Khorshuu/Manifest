/**
 * Unpaid orders release their places after the hold window (D-052).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  categories,
  notifications,
  orderStatusHistory,
  orders,
  payments,
  products,
  productVariants,
  users,
} from "@/db/schema";
import { updateSetting } from "@/lib/admin";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { advanceOrder, confirmPayment, expireUnpaidOrders, placeOrder } from "@/lib/orders";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import { MockPaymentProvider, setPaymentProviderForTesting, type PaymentMethod } from "@/lib/providers/payment";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let customerId = "";
let addressId = "";
let staff: SessionUser;
let owner: SessionUser;

const MINUTE = 60_000;

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
  setPaymentProviderForTesting(new MockPaymentProvider());

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "owner@example.com", passwordHash: "x", role: "super_admin" },
    ])
    .returning({ id: users.id, role: users.role, email: users.email });
  customerId = rows.find((row) => row.role === "customer")!.id;
  const staffRow = rows.find((row) => row.role === "staff_admin")!;
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };
  const ownerRow = rows.find((row) => row.role === "super_admin")!;
  owner = { id: ownerRow.id, email: ownerRow.email, role: "super_admin" };

  const [address] = await harness.db
    .insert(addresses)
    .values({ userId: customerId, recipientName: "A", phone: "+8801700000000", addressLine1: "1 Road", city: "Dhaka", district: "Dhaka" })
    .returning({ id: addresses.id });
  addressId = address.id;
});

async function variant(mode: "preorder" | "in_stock" = "preorder") {
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: `c-${Math.random()}` }).returning({ id: categories.id });
  const [product] = await harness.db
    .insert(products)
    .values({ categoryId: category.id, title: "Held", slug: `held-${Math.random()}`, status: mode === "preorder" ? "preorder_open" : "in_stock" })
    .returning({ id: products.id });
  const [row] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `HOLD-${Math.random()}`,
      priceBdt: 500_00,
      fulfillmentMode: mode,
      preorderCapacity: mode === "preorder" ? 5 : null,
      stockQuantity: mode === "in_stock" ? 5 : null,
      preorderClosesAt: mode === "preorder" ? new Date(Date.now() + 86_400_000) : null,
    })
    .returning({ id: productVariants.id });
  return row.id;
}

/** Places an order for two units, then backdates it. */
async function order(options: { minutesAgo: number; method?: PaymentMethod; mode?: "preorder" | "in_stock" }) {
  const variantId = await variant(options.mode);
  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variantId, 2);
  const placed = await placeOrder({
    cartId,
    userId: customerId,
    guestEmail: "shopper@example.com",
    guestPhone: null,
    shippingAddressId: addressId,
    method: options.method ?? "bkash",
    idempotencyKey: `hold-${Math.random()}`,
  });
  await harness.db
    .update(orders)
    .set({ placedAt: new Date(Date.now() - options.minutesAgo * MINUTE) })
    .where(eq(orders.id, placed.orderId));
  return { ...placed, variantId };
}

async function state(orderId: string, variantId: string) {
  const [row] = await harness.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  const [capacity] = await harness.db
    .select({ reserved: productVariants.preorderReserved, stock: productVariants.stockQuantity })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return { status: row.status, reserved: capacity.reserved, stock: capacity.stock };
}

describe("an unpaid order past its hold", () => {
  it("is cancelled, releases its places, records why and tells the customer", async () => {
    const placed = await order({ minutesAgo: 31 });
    expect((await state(placed.orderId, placed.variantId)).reserved).toBe(2);

    const report = await expireUnpaidOrders();

    expect(report.expired).toEqual([placed.orderId]);
    expect(await state(placed.orderId, placed.variantId)).toMatchObject({ status: "cancelled", reserved: 0 });

    const history = await harness.db
      .select({ note: orderStatusHistory.note, actor: orderStatusHistory.actorUserId })
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, placed.orderId), eq(orderStatusHistory.status, "cancelled")));
    expect(history).toEqual([{ note: expect.stringMatching(/No payment within 30 minutes/), actor: null }]);

    const messages = await harness.db
      .select({ template: notifications.template })
      .from(notifications)
      .where(eq(notifications.orderId, placed.orderId));
    expect(messages.map((message) => message.template)).toContain("order.cancelled");
  });

  it("returns in-stock units to stock as well", async () => {
    const placed = await order({ minutesAgo: 45, mode: "in_stock", method: "card" });
    expect((await state(placed.orderId, placed.variantId)).stock).toBe(3);

    await expireUnpaidOrders();

    expect((await state(placed.orderId, placed.variantId)).stock).toBe(5);
  });

  it("releases nothing a second time when the sweep runs again", async () => {
    const placed = await order({ minutesAgo: 31 });

    await expireUnpaidOrders();
    const second = await expireUnpaidOrders();

    expect(second.expired).toEqual([]);
    expect((await state(placed.orderId, placed.variantId)).reserved).toBe(0);
    const cancellations = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, placed.orderId), eq(orderStatusHistory.status, "cancelled")));
    expect(cancellations).toHaveLength(1);
  });
});

describe("orders the sweep must leave alone", () => {
  it("an order still inside its hold", async () => {
    const placed = await order({ minutesAgo: 29 });
    await expireUnpaidOrders();
    expect((await state(placed.orderId, placed.variantId)).status).toBe("placed");
  });

  it("an order that has been paid", async () => {
    const placed = await order({ minutesAgo: 90 });
    const [payment] = await harness.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    await confirmPayment(payment.providerRef!);

    await expireUnpaidOrders();

    expect(await state(placed.orderId, placed.variantId)).toMatchObject({ status: "payment_confirmed", reserved: 2 });
  });

  it("a cash-on-delivery order, which is paid at the door", async () => {
    const placed = await order({ minutesAgo: 600, mode: "in_stock", method: "cod" });
    await expireUnpaidOrders();
    expect((await state(placed.orderId, placed.variantId)).status).toBe("placed");
  });

  it("an order staff have already moved on", async () => {
    const placed = await order({ minutesAgo: 90 });
    await advanceOrder(staff, placed.orderId, "cancelled", "customer asked");
    const before = await state(placed.orderId, placed.variantId);

    const report = await expireUnpaidOrders();

    expect(report.expired).toEqual([]);
    expect(await state(placed.orderId, placed.variantId)).toEqual(before);
  });
});

describe("the hold window", () => {
  it("follows the owner's setting", async () => {
    await updateSetting(owner, "orders.unpaid_hold_minutes", 120);
    const young = await order({ minutesAgo: 90 });
    const old = await order({ minutesAgo: 130 });

    const report = await expireUnpaidOrders();

    expect(report.expired).toEqual([old.orderId]);
    expect((await state(young.orderId, young.variantId)).status).toBe("placed");
  });
});
