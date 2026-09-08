/**
 * Reporting.
 *
 * The point of these tests is that the numbers are honest: revenue counts only
 * money collected, the funnel says what it cannot measure rather than guessing,
 * and financial figures stay behind the super-admin gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addresses, productVariants, users } from "@/db/schema";
import {
  getFunnel,
  getPreorderCommitment,
  getRevenueByDay,
  getSignupsByDay,
  getStatusBreakdown,
  lastDays,
} from "@/lib/admin";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import { advanceOrder, placeOrder } from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const superAdmin: SessionUser = {
  id: "",
  email: "admin@example.com",
  role: "super_admin",
};
const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "shopper@example.com",
  role: "customer",
};

let addressId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider());

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "admin@example.com", passwordHash: "x", role: "super_admin" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  superAdmin.id = rows.find((r) => r.email === "admin@example.com")!.id;
  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  customer.id = rows.find((r) => r.email === "shopper@example.com")!.id;

  const [address] = await harness.db
    .insert(addresses)
    .values({
      userId: customer.id,
      recipientName: "A Shopper",
      phone: "+8801700000000",
      addressLine1: "12 Example Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });

  addressId = address.id;
});

async function placeTestOrder(price = 500_00, quantity = 2) {
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
      priceBdt: price,
      fulfillmentMode: "preorder",
      preorderCapacity: 10,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, quantity);

  return placeOrder({
    cartId,
    userId: customer.id,
    guestEmail: customer.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });
}

describe("lastDays", () => {
  it("spans the requested number of days ending now", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const range = lastDays(7, now);

    expect(range.to).toBe(now);
    expect(range.from.toISOString()).toBe("2026-03-03T12:00:00.000Z");
  });
});

describe("funnel", () => {
  it("refuses a customer", async () => {
    await expect(getFunnel(customer, lastDays(30))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("counts each stage from what is recorded", async () => {
    const placed = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "payment_confirmed");

    const funnel = await getFunnel(staff, lastDays(30));
    const byLabel = Object.fromEntries(
      funnel.steps.map((step) => [step.label, step.value]),
    );

    expect(byLabel["Carts started"]).toBe(1);
    expect(byLabel["Orders placed"]).toBe(1);
    expect(byLabel["Payment confirmed"]).toBe(1);
    expect(byLabel["Delivered"]).toBe(0);
  });

  it("reports conversion between consecutive steps", async () => {
    await placeTestOrder();
    await placeTestOrder();
    const third = await placeTestOrder();
    await advanceOrder(staff, third.orderId, "payment_confirmed");

    const funnel = await getFunnel(staff, lastDays(30));
    const paid = funnel.steps.find((s) => s.label === "Payment confirmed")!;

    // One of three placed orders reached payment.
    expect(paid.conversionFromPrevious).toBeCloseTo(1 / 3, 5);
  });

  it("gives the first step no conversion figure, since nothing precedes it", async () => {
    const funnel = await getFunnel(staff, lastDays(30));
    expect(funnel.steps[0].conversionFromPrevious).toBeNull();
  });

  it("reports zero rather than dividing by zero on an empty period", async () => {
    const funnel = await getFunnel(staff, lastDays(30));
    for (const step of funnel.steps.slice(1)) {
      expect(step.conversionFromPrevious).toBe(0);
    }
  });

  /**
   * The honest part: nothing records product views, so the funnel says so
   * instead of inventing a top-of-funnel number.
   */
  it("names what it cannot measure", async () => {
    const funnel = await getFunnel(staff, lastDays(30));

    expect(funnel.missing.length).toBeGreaterThan(0);
    expect(funnel.missing.join(" ")).toMatch(/product views/i);
  });

  it("excludes activity outside the window", async () => {
    await placeTestOrder();

    // A window that ended before anything happened.
    const past = {
      from: new Date("2020-01-01T00:00:00Z"),
      to: new Date("2020-01-31T00:00:00Z"),
    };

    const funnel = await getFunnel(staff, past);
    expect(funnel.steps.every((step) => step.value === 0)).toBe(true);
  });
});

describe("revenue by day", () => {
  it("refuses a staff admin, because it is money", async () => {
    await expect(getRevenueByDay(staff, lastDays(30))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("counts only orders that got past payment", async () => {
    const placed = await placeTestOrder(500_00, 2);

    // Still awaiting payment.
    await expect(getRevenueByDay(superAdmin, lastDays(30))).resolves.toEqual(
      [],
    );

    await advanceOrder(staff, placed.orderId, "payment_confirmed");

    const points = await getRevenueByDay(superAdmin, lastDays(30));
    expect(points).toHaveLength(1);
    expect(points[0].collectedBdt).toBe(1_000_00);
    expect(points[0].orderCount).toBe(1);
  });

  it("drops a refunded order back out of revenue", async () => {
    const placed = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "payment_confirmed");
    await advanceOrder(staff, placed.orderId, "refunded");

    await expect(getRevenueByDay(superAdmin, lastDays(30))).resolves.toEqual(
      [],
    );
  });

  it("groups by day", async () => {
    const first = await placeTestOrder();
    const second = await placeTestOrder();
    await advanceOrder(staff, first.orderId, "payment_confirmed");
    await advanceOrder(staff, second.orderId, "payment_confirmed");

    const points = await getRevenueByDay(superAdmin, lastDays(30));
    // Both placed today, so one bucket.
    expect(points).toHaveLength(1);
    expect(points[0].orderCount).toBe(2);
  });
});

describe("preorder commitment", () => {
  it("refuses a customer", async () => {
    await expect(getPreorderCommitment(customer)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("reports utilisation across capped variants", async () => {
    await placeTestOrder(500_00, 4);

    const commitment = await getPreorderCommitment(staff);
    expect(commitment.totalCapacity).toBe(10);
    expect(commitment.totalReserved).toBe(4);
    expect(commitment.utilisation).toBeCloseTo(0.4, 5);
  });

  it("reports zero utilisation rather than dividing by zero", async () => {
    const commitment = await getPreorderCommitment(staff);
    expect(commitment.totalCapacity).toBe(0);
    expect(commitment.utilisation).toBe(0);
  });

  it("counts variants that are full", async () => {
    await placeTestOrder(500_00, 10);

    const commitment = await getPreorderCommitment(staff);
    expect(commitment.fullVariants).toBe(1);
  });
});

describe("signups by day", () => {
  it("counts customers, not staff", async () => {
    const points = await getSignupsByDay(staff, lastDays(30));
    const total = points.reduce((sum, point) => sum + point.count, 0);

    // Three seeded users, one of them a customer.
    expect(total).toBe(1);
  });
});

describe("status breakdown", () => {
  it("counts orders at each stage", async () => {
    const first = await placeTestOrder();
    await placeTestOrder();
    await advanceOrder(staff, first.orderId, "payment_confirmed");

    const breakdown = await getStatusBreakdown(staff);
    const byStatus = Object.fromEntries(
      breakdown.map((row) => [row.status, row.count]),
    );

    expect(byStatus.placed).toBe(1);
    expect(byStatus.payment_confirmed).toBe(1);
  });

  it("refuses a customer", async () => {
    await expect(getStatusBreakdown(customer)).rejects.toThrow(
      AuthorizationError,
    );
  });
});
