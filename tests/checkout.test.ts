/**
 * Cart and checkout against a real (in-process) Postgres.
 *
 * The assertions here are the non-negotiable rules from CLAUDE.md §7: the
 * server computes every total, capacity is reserved atomically with the order,
 * and a retried placement never creates a second order or a second charge.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  cartItems,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  productVariants,
  users,
} from "@/db/schema";
import {
  addToCart,
  getCartView,
  getOrCreateCart,
  mergeGuestCart,
  newCartToken,
  updateCartItem,
  VariantUnavailableError,
} from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  CheckoutError,
  confirmPayment,
  getGuestOrder,
  placeOrder,
} from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
  type PaymentMethod,
} from "@/lib/providers/payment";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let provider: MockPaymentProvider;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

let customerId = "";
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

  provider = new MockPaymentProvider();
  setPaymentProviderForTesting(provider);

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, role: users.role });

  staff.id = rows.find((r) => r.role === "staff_admin")!.id;
  customerId = rows.find((r) => r.role === "customer")!.id;

  const [address] = await harness.db
    .insert(addresses)
    .values({
      userId: customerId,
      recipientName: "A Shopper",
      phone: "+8801700000000",
      addressLine1: "12 Example Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });

  addressId = address.id;
});

const HOUR = 60 * 60 * 1000;

async function seedVariant(
  overrides: Partial<{
    priceBdt: number;
    fulfillmentMode: "in_stock" | "preorder";
    preorderCapacity: number | null;
    preorderReserved: number;
    stockQuantity: number | null;
    paymentMode: "full" | "deposit";
    depositPercent: number | null;
    preorderClosesAt: Date | null;
  }> = {},
) {
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
      priceBdt: overrides.priceBdt ?? 1_000_00,
      fulfillmentMode: overrides.fulfillmentMode ?? "preorder",
      preorderCapacity:
        overrides.preorderCapacity === undefined
          ? 10
          : overrides.preorderCapacity,
      preorderReserved: overrides.preorderReserved ?? 0,
      stockQuantity: overrides.stockQuantity ?? null,
      preorderClosesAt:
        overrides.preorderClosesAt === undefined
          ? new Date(Date.now() + 24 * HOUR)
          : overrides.preorderClosesAt,
      paymentMode: overrides.paymentMode ?? "full",
      depositPercent: overrides.depositPercent ?? null,
    })
    .returning();

  return variant;
}

async function cartFor(): Promise<string> {
  return getOrCreateCart({ sessionToken: newCartToken() });
}

describe("cart totals", () => {
  it("computes the subtotal from the live price, not a stored one", async () => {
    const variant = await seedVariant({ priceBdt: 500_00 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 2);

    // The price changes after the item is in the cart.
    await harness.db
      .update(productVariants)
      .set({ priceBdt: 750_00 })
      .where(eq(productVariants.id, variant.id));

    const view = await getCartView(cartId);
    expect(view.lines[0].unitPriceBdt).toBe(750_00);
    expect(view.subtotalBdt).toBe(1_500_00);
  });

  it("charges only the deposit at placement for a deposit variant", async () => {
    const variant = await seedVariant({
      priceBdt: 1_000_00,
      paymentMode: "deposit",
      depositPercent: 40,
    });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const view = await getCartView(cartId);
    expect(view.subtotalBdt).toBe(1_000_00);
    expect(view.dueNowBdt).toBe(400_00);
  });

  it("stores no price on the cart row itself", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const [row] = await harness.db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cartId));

    expect(Object.keys(row)).not.toContain("priceBdt");
  });
});

describe("cart problems", () => {
  it("flags a line whose preorder has closed", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    await harness.db
      .update(productVariants)
      .set({ preorderClosesAt: new Date(Date.now() - HOUR) })
      .where(eq(productVariants.id, variant.id));

    const view = await getCartView(cartId);
    expect(view.lines[0].problem).toMatch(/closed/i);
    expect(view.hasProblems).toBe(true);
  });

  it("flags a line whose quantity now exceeds what is left", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 5);

    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 8 })
      .where(eq(productVariants.id, variant.id));

    const view = await getCartView(cartId);
    expect(view.lines[0].problem).toMatch(/Only 2 left/);
  });

  it("flags a line whose variant was disabled", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    await harness.db
      .update(productVariants)
      .set({ isEnabled: false })
      .where(eq(productVariants.id, variant.id));

    const view = await getCartView(cartId);
    expect(view.lines[0].problem).toMatch(/no longer sold/i);
  });

  it("refuses to add more than remains", async () => {
    const variant = await seedVariant({
      preorderCapacity: 3,
      preorderReserved: 1,
    });
    const cartId = await cartFor();

    await expect(addToCart(cartId, variant.id, 5)).rejects.toThrow(
      VariantUnavailableError,
    );
  });

  it("refuses to add to a closed preorder", async () => {
    const variant = await seedVariant({
      preorderClosesAt: new Date(Date.now() - HOUR),
    });
    const cartId = await cartFor();

    await expect(addToCart(cartId, variant.id, 1)).rejects.toThrow(/closed/i);
  });
});

describe("guest cart merge", () => {
  it("takes the higher quantity when both carts hold the same variant", async () => {
    const variant = await seedVariant();
    const token = newCartToken();

    const guestCart = await getOrCreateCart({ sessionToken: token });
    await addToCart(guestCart, variant.id, 3);

    const userCart = await getOrCreateCart({ userId: customerId });
    await addToCart(userCart, variant.id, 1);

    await mergeGuestCart(token, customerId);

    const view = await getCartView(userCart);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].quantity).toBe(3);
  });

  it("moves a variant the account did not have", async () => {
    const variant = await seedVariant();
    const token = newCartToken();

    const guestCart = await getOrCreateCart({ sessionToken: token });
    await addToCart(guestCart, variant.id, 2);

    await mergeGuestCart(token, customerId);

    const userCart = await getOrCreateCart({ userId: customerId });
    const view = await getCartView(userCart);
    expect(view.lines[0].quantity).toBe(2);
  });
});

describe("placing an order", () => {
  async function place(
    cartId: string,
    key = "key-1",
    method: PaymentMethod = "card",
  ) {
    return placeOrder({
      cartId,
      userId: customerId,
      guestEmail: "shopper@example.com",
      guestPhone: null,
      shippingAddressId: addressId,
      method,
      idempotencyKey: key,
    });
  }

  it("computes the total on the server and records it", async () => {
    const variant = await seedVariant({ priceBdt: 250_00 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 3);

    const placed = await place(cartId);

    expect(placed.totalBdt).toBe(750_00);

    const [order] = await harness.db
      .select()
      .from(orders)
      .where(eq(orders.id, placed.orderId));
    expect(order.subtotalBdt).toBe(750_00);
  });

  it("reserves capacity as part of placing the order", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 4);

    await place(cartId);

    const [after] = await harness.db
      .select({ reserved: productVariants.preorderReserved })
      .from(productVariants)
      .where(eq(productVariants.id, variant.id));
    expect(after.reserved).toBe(4);
  });

  /**
   * The rule that makes a retry safe: same key, same order, one charge.
   */
  it("returns the same order for a repeated idempotency key", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const first = await place(cartId, "same-key");
    const second = await place(cartId, "same-key");

    expect(second.orderId).toBe(first.orderId);
    expect(second.reused).toBe(true);

    const allOrders = await harness.db.select().from(orders);
    expect(allOrders).toHaveLength(1);

    const allPayments = await harness.db.select().from(payments);
    expect(allPayments).toHaveLength(1);
  });

  it("does not reserve capacity twice for a repeated key", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 2);

    await place(cartId, "same-key");
    await place(cartId, "same-key");

    const [after] = await harness.db
      .select({ reserved: productVariants.preorderReserved })
      .from(productVariants)
      .where(eq(productVariants.id, variant.id));
    expect(after.reserved).toBe(2);
  });

  it("empties the cart", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    await place(cartId);

    const view = await getCartView(cartId);
    expect(view.lines).toHaveLength(0);
  });

  it("snapshots the title and price onto the order line", async () => {
    const variant = await seedVariant({ priceBdt: 300_00 });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const placed = await place(cartId);

    await harness.db
      .update(productVariants)
      .set({ priceBdt: 999_00 })
      .where(eq(productVariants.id, variant.id));

    const [item] = await harness.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));

    // History does not move when the catalog does.
    expect(item.unitPriceBdt).toBe(300_00);
  });

  it("records the first status history entry", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const placed = await place(cartId);

    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, placed.orderId));

    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("placed");
  });

  /**
   * A preorder funds the US purchase, so it cannot be paid on delivery
   * (MASTER_PRODUCT_SPEC.md §5.5).
   */
  it("refuses cash on delivery for a preorder", async () => {
    const variant = await seedVariant({ fulfillmentMode: "preorder" });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    await expect(place(cartId, "cod-key", "cod")).rejects.toThrow(
      /Cash on delivery/,
    );
  });

  it("allows cash on delivery for an in-stock order", async () => {
    const variant = await seedVariant({
      fulfillmentMode: "in_stock",
      stockQuantity: 5,
      preorderCapacity: null,
      preorderClosesAt: null,
    });
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    await expect(place(cartId, "cod-ok", "cod")).resolves.toMatchObject({
      reused: false,
    });
  });

  it("refuses an empty cart", async () => {
    const cartId = await cartFor();
    await expect(place(cartId)).rejects.toThrow(CheckoutError);
  });

  it("refuses an address belonging to someone else", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const [other] = await harness.db
      .insert(users)
      .values({ email: "other@example.com", passwordHash: "x", role: "customer" })
      .returning({ id: users.id });

    const [otherAddress] = await harness.db
      .insert(addresses)
      .values({
        userId: other.id,
        recipientName: "Someone Else",
        phone: "+8801711111111",
        addressLine1: "9 Other Road",
        city: "Dhaka",
        district: "Dhaka",
      })
      .returning({ id: addresses.id });

    await expect(
      placeOrder({
        cartId,
        userId: customerId,
        guestEmail: null,
        guestPhone: null,
        shippingAddressId: otherAddress.id,
        method: "card",
        idempotencyKey: "steal",
      }),
    ).rejects.toThrow(/not yours/);
  });

  /**
   * Capacity and the order commit together: if the order cannot be written,
   * no slot may stay held.
   */
  it("holds no capacity when placement fails", async () => {
    const good = await seedVariant({ preorderCapacity: 10 });
    const full = await seedVariant({
      preorderCapacity: 1,
      preorderReserved: 1,
    });

    const cartId = await cartFor();
    await addToCart(cartId, good.id, 1);
    // Added directly: addToCart would refuse a full variant, and the point is
    // to fail inside the placement transaction.
    await harness.db
      .insert(cartItems)
      .values({ cartId, variantId: full.id, quantity: 1 });

    await expect(place(cartId, "fails")).rejects.toThrow();

    const [after] = await harness.db
      .select({ reserved: productVariants.preorderReserved })
      .from(productVariants)
      .where(eq(productVariants.id, good.id));

    expect(after.reserved).toBe(0);
    await expect(harness.db.select().from(orders)).resolves.toHaveLength(0);
  });
});

describe("confirming payment", () => {
  async function placeAndRef() {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const placed = await placeOrder({
      cartId,
      userId: customerId,
      guestEmail: "shopper@example.com",
      guestPhone: null,
      shippingAddressId: addressId,
      method: "bkash",
      idempotencyKey: `key-${Math.random()}`,
    });

    const [payment] = await harness.db
      .select({ providerRef: payments.providerRef })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    return { placed, providerRef: payment.providerRef! };
  }

  it("moves the order to payment_confirmed", async () => {
    const { placed, providerRef } = await placeAndRef();

    const result = await confirmPayment(providerRef);

    expect(result.status).toBe("payment_confirmed");
    expect(result.alreadyConfirmed).toBe(false);

    const [order] = await harness.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, placed.orderId));
    expect(order.status).toBe("payment_confirmed");
  });

  /**
   * Gateways retry. A replayed webhook must not confirm twice or write a
   * second history entry (docs/SECURITY.md).
   */
  it("is idempotent when the webhook is replayed", async () => {
    const { placed, providerRef } = await placeAndRef();

    await confirmPayment(providerRef);
    const second = await confirmPayment(providerRef);

    expect(second.alreadyConfirmed).toBe(true);

    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, placed.orderId));

    // 'placed' and 'payment_confirmed' — not three entries.
    expect(history).toHaveLength(2);
  });

  it("records the confirmation with no staff actor", async () => {
    const { placed, providerRef } = await placeAndRef();
    await confirmPayment(providerRef);

    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, placed.orderId));

    const confirmation = history.find(
      (entry) => entry.status === "payment_confirmed",
    );
    expect(confirmation?.actorUserId).toBeNull();
  });

  it("rejects an unknown payment reference", async () => {
    await expect(confirmPayment("mock_nope")).rejects.toThrow(/unknown/i);
  });
});

describe("guest order lookup", () => {
  it("needs the email as well as the order number", async () => {
    const variant = await seedVariant();
    const cartId = await cartFor();
    await addToCart(cartId, variant.id, 1);

    const placed = await placeOrder({
      cartId,
      userId: null,
      guestEmail: "guest@example.com",
      guestPhone: "+8801700000001",
      shippingAddressId: addressId,
      method: "card",
      idempotencyKey: "guest-1",
    });

    await expect(
      getGuestOrder(placed.orderNumber, "guest@example.com"),
    ).resolves.not.toBeNull();

    // The order number alone is not enough.
    await expect(
      getGuestOrder(placed.orderNumber, "someone-else@example.com"),
    ).resolves.toBeNull();
  });
});

describe("cart item scoping", () => {
  it("cannot change an item belonging to another cart", async () => {
    const variant = await seedVariant();
    const mine = await cartFor();
    const theirs = await cartFor();

    await addToCart(theirs, variant.id, 1);
    const theirView = await getCartView(theirs);
    const theirItemId = theirView.lines[0].itemId;

    await updateCartItem(mine, theirItemId, 99);

    const unchanged = await getCartView(theirs);
    expect(unchanged.lines[0].quantity).toBe(1);
  });
});
