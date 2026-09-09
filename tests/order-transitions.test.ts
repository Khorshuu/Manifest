/**
 * Order status transitions and refunds.
 *
 * The rules with money behind them: status never moves backward, cancelling
 * returns capacity only while the order still holds it, and a refund always
 * produces a payment row rather than a silent adjustment.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  auditLog,
  orderStatusHistory,
  orders,
  payments,
  productVariants,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  advanceOrder,
  allowedTransitions,
  canTransition,
  requestCancellation,
  resolveCancellationRequest,
  listCancellationRequests,
  CancellationError,
  confirmPayment,
  listOrdersForStaff,
  placeOrder,
  refundOrder,
  TransitionError,
} from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
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
const otherShopper: SessionUser = {
  id: "",
  email: "other@example.com",
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
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
      { email: "other@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  shopper.id = rows.find((r) => r.email === "shopper@example.com")!.id;
  otherShopper.id = rows.find((r) => r.email === "other@example.com")!.id;

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

/** Places an order for one preorder variant with the given capacity. */
async function placeTestOrder(capacity = 10, quantity = 2) {
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
      preorderCapacity: capacity,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, quantity);

  const placed = await placeOrder({
    cartId,
    userId: shopper.id,
    guestEmail: shopper.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });

  return { placed, variantId: variant.id };
}

async function reservedFor(variantId: string) {
  const [row] = await harness.db
    .select({ reserved: productVariants.preorderReserved })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return row.reserved;
}

describe("allowedTransitions", () => {
  it("moves one step forward through the pipeline", () => {
    expect(allowedTransitions("placed")).toContain("payment_confirmed");
    expect(allowedTransitions("sourcing")).toContain("shipped_from_us");
  });

  it("never allows a step backward", () => {
    expect(canTransition("shipped_from_us", "sourcing")).toBe(false);
    expect(canTransition("delivered", "out_for_delivery")).toBe(false);
  });

  it("never allows skipping a step", () => {
    expect(canTransition("placed", "delivered")).toBe(false);
    expect(canTransition("payment_confirmed", "in_bd_customs")).toBe(false);
  });

  it("offers cancel and refund while an order is in flight", () => {
    expect(allowedTransitions("sourcing")).toContain("cancelled");
    expect(allowedTransitions("sourcing")).toContain("refunded");
  });

  it("offers only a refund on a delivered order", () => {
    expect(allowedTransitions("delivered")).toEqual(["refunded"]);
  });

  it("allows nothing from a terminal status", () => {
    expect(allowedTransitions("cancelled")).toEqual([]);
    expect(allowedTransitions("refunded")).toEqual([]);
  });
});

describe("advanceOrder", () => {
  it("refuses a customer", async () => {
    const { placed } = await placeTestOrder();
    await expect(
      advanceOrder(shopper, placed.orderId, "payment_confirmed"),
    ).rejects.toThrow(AuthorizationError);
  });

  it("moves the order and writes a history entry with the actor", async () => {
    const { placed } = await placeTestOrder();

    await advanceOrder(staff, placed.orderId, "payment_confirmed", "Paid.");

    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, placed.orderId));

    const entry = history.find((row) => row.status === "payment_confirmed");
    expect(entry?.actorUserId).toBe(staff.id);
    expect(entry?.note).toBe("Paid.");
  });

  it("refuses a backward move", async () => {
    const { placed } = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "payment_confirmed");
    await advanceOrder(staff, placed.orderId, "sourcing");

    await expect(
      advanceOrder(staff, placed.orderId, "payment_confirmed"),
    ).rejects.toThrow(TransitionError);
  });

  it("refuses to skip a step", async () => {
    const { placed } = await placeTestOrder();
    await expect(
      advanceOrder(staff, placed.orderId, "delivered"),
    ).rejects.toThrow(TransitionError);
  });

  it("writes an audit row for each change", async () => {
    const { placed } = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "payment_confirmed");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "order.status_changed"));

    expect(entries).toHaveLength(1);
    expect(entries[0].beforeJson).toMatchObject({ status: "placed" });
  });
});

describe("cancelling", () => {
  it("returns capacity when the order had not been sourced", async () => {
    const { placed, variantId } = await placeTestOrder(10, 3);
    expect(await reservedFor(variantId)).toBe(3);

    await advanceOrder(staff, placed.orderId, "cancelled", "Shopper asked.");

    expect(await reservedFor(variantId)).toBe(0);
  });

  /**
   * Once sourcing has begun the item has been bought in the US, so the slot is
   * genuinely consumed and must not be handed to someone else.
   */
  it("keeps capacity consumed once sourcing has begun", async () => {
    const { placed, variantId } = await placeTestOrder(10, 3);

    await advanceOrder(staff, placed.orderId, "payment_confirmed");
    await advanceOrder(staff, placed.orderId, "sourcing");
    await advanceOrder(staff, placed.orderId, "cancelled");

    expect(await reservedFor(variantId)).toBe(3);
  });

  /*
   * A shopper asking to cancel records a request; staff make the final call
   * (DECISIONS.md D-014). The order keeps its status and — importantly — its
   * capacity, because until somebody decides, the place is still theirs.
   */
  it("records a request rather than cancelling, and holds the places", async () => {
    const { placed, variantId } = await placeTestOrder(10, 2);

    await requestCancellation(shopper, placed.orderId, "Ordered by mistake");

    const [order] = await harness.db
      .select({
        status: orders.status,
        requestedAt: orders.cancellationRequestedAt,
        reason: orders.cancellationReason,
      })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(order.status).toBe("placed");
    expect(order.requestedAt).not.toBeNull();
    expect(order.reason).toBe("Ordered by mistake");
    expect(await reservedFor(variantId)).toBe(2);
  });

  it("shows the request to staff", async () => {
    const { placed } = await placeTestOrder();
    await requestCancellation(shopper, placed.orderId, "Changed my mind");

    const queue = await listCancellationRequests(staff);
    const mine = queue.find((row) => row.id === placed.orderId);

    expect(mine).toBeDefined();
    expect(mine!.reason).toBe("Changed my mind");
  });

  it("cancels and returns the places when staff approve", async () => {
    const { placed, variantId } = await placeTestOrder(10, 2);
    await requestCancellation(shopper, placed.orderId, "No longer needed");

    await resolveCancellationRequest(staff, placed.orderId, "approve");

    const [order] = await harness.db
      .select({
        status: orders.status,
        requestedAt: orders.cancellationRequestedAt,
      })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(order.status).toBe("cancelled");
    expect(order.requestedAt).toBeNull();
    expect(await reservedFor(variantId)).toBe(0);
  });

  it("leaves the order alone when staff decline", async () => {
    const { placed, variantId } = await placeTestOrder(10, 2);
    await requestCancellation(shopper, placed.orderId, "Maybe");

    await resolveCancellationRequest(
      staff,
      placed.orderId,
      "decline",
      "Already shipped from the US",
    );

    const [order] = await harness.db
      .select({
        status: orders.status,
        requestedAt: orders.cancellationRequestedAt,
      })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(order.status).toBe("placed");
    expect(order.requestedAt).toBeNull();
    expect(await reservedFor(variantId)).toBe(2);
  });

  it("treats asking twice as asking once", async () => {
    const { placed } = await placeTestOrder();

    const first = await requestCancellation(shopper, placed.orderId, "One");
    const second = await requestCancellation(shopper, placed.orderId, "Two");

    expect(first.alreadyRequested).toBe(false);
    expect(second.alreadyRequested).toBe(true);
  });

  it("refuses a customer trying to answer their own request", async () => {
    const { placed } = await placeTestOrder();
    await requestCancellation(shopper, placed.orderId, "Please");

    await expect(
      resolveCancellationRequest(shopper, placed.orderId, "approve"),
    ).rejects.toThrow();
  });

  it("refuses to let a shopper cancel someone else's order", async () => {
    const { placed } = await placeTestOrder();
    await expect(
      requestCancellation(otherShopper, placed.orderId, "Not mine"),
    ).rejects.toThrow(/not yours/);
  });

  /*
   * A request is allowed while the goods are still coming, sourcing included —
   * that is the case staff most need to see, because it is the one where the
   * item has been bought and somebody has to decide what to do about it.
   */
  it("allows a request once sourcing has begun", async () => {
    const { placed } = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "payment_confirmed");
    await advanceOrder(staff, placed.orderId, "sourcing");

    const result = await requestCancellation(shopper, placed.orderId, "Sorry");
    expect(result.status).toBe("sourcing");
  });

  it("refuses a request on an order that is already cancelled", async () => {
    const { placed } = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "cancelled");

    await expect(
      requestCancellation(shopper, placed.orderId, "Too late"),
    ).rejects.toThrow(CancellationError);
  });

  it("refuses an anonymous caller", async () => {
    const { placed } = await placeTestOrder();
    await expect(
      requestCancellation(null, placed.orderId, "Anyone"),
    ).rejects.toThrow();
  });
});

describe("refunding", () => {
  async function placeAndPay() {
    const { placed, variantId } = await placeTestOrder(10, 2);

    const [payment] = await harness.db
      .select({ providerRef: payments.providerRef })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    await confirmPayment(payment.providerRef!);
    return { placed, variantId };
  }

  it("refuses a customer", async () => {
    const { placed } = await placeAndPay();
    await expect(
      refundOrder(shopper, placed.orderId, "changed mind"),
    ).rejects.toThrow(AuthorizationError);
  });

  /** A refund is always a payment row, never a silent adjustment. */
  it("records a refund payment row rather than adjusting the order", async () => {
    const { placed } = await placeAndPay();

    await refundOrder(staff, placed.orderId, "Batch cancelled.");

    const rows = await harness.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    const refund = rows.find((row) => row.kind === "refund");
    expect(refund).toBeDefined();
    expect(refund!.status).toBe("refunded");
    // Negative, so summing a customer's rows gives what they actually paid.
    expect(refund!.amountBdt).toBeLessThan(0);

    const [order] = await harness.db
      .select({ total: orders.totalBdt, status: orders.status })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    // The order's own totals are history and do not move.
    expect(order.total).toBe(1_000_00);
    expect(order.status).toBe("refunded");
  });

  it("nets to zero across the payment rows", async () => {
    const { placed } = await placeAndPay();
    await refundOrder(staff, placed.orderId, "Batch cancelled.");

    const rows = await harness.db
      .select({ amountBdt: payments.amountBdt })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    const net = rows.reduce((sum, row) => sum + row.amountBdt, 0);
    expect(net).toBe(0);
  });

  it("refuses to refund twice", async () => {
    const { placed } = await placeAndPay();
    await refundOrder(staff, placed.orderId, "first");

    await expect(
      refundOrder(staff, placed.orderId, "second"),
    ).rejects.toThrow(/already been refunded/);
  });

  it("writes an audit row", async () => {
    const { placed } = await placeAndPay();
    await refundOrder(staff, placed.orderId, "Batch cancelled.");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "order.refunded"));

    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(staff.id);
  });

  it("returns capacity when refunding an unsourced order", async () => {
    const { placed, variantId } = await placeAndPay();
    await refundOrder(staff, placed.orderId, "Batch cancelled.");
    expect(await reservedFor(variantId)).toBe(0);
  });
});

describe("staff order list", () => {
  it("refuses a customer", async () => {
    await expect(listOrdersForStaff(shopper)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("filters by status", async () => {
    const first = await placeTestOrder();
    await placeTestOrder();

    await advanceOrder(staff, first.placed.orderId, "payment_confirmed");

    const confirmed = await listOrdersForStaff(staff, {
      status: "payment_confirmed",
    });
    expect(confirmed).toHaveLength(1);

    const placedOnly = await listOrdersForStaff(staff, { status: "placed" });
    expect(placedOnly).toHaveLength(1);
  });
});
