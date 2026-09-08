/**
 * Shipment booking, tracking references, and internal notes.
 *
 * The rules here are about not doing something twice and not leaking staff
 * notes: booking is idempotent per order, and internal notes never travel to
 * a customer-facing query.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  auditLog,
  orderStatusHistory,
  orders,
  productVariants,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  addInternalNote,
  advanceOrder,
  bookShipment,
  getGuestOrder,
  placeOrder,
  setTrackingReference,
  ShipmentError,
  trackOrder,
} from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import {
  MockShippingProvider,
  setShippingProviderForTesting,
} from "@/lib/providers/shipping";
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
}, 60_000);

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  setShippingProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider());
  setShippingProviderForTesting(new MockShippingProvider());

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

async function placeTestOrder(weightGrams: number | null = 500) {
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
      preorderCapacity: 50,
      weightGrams,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, 2);

  return placeOrder({
    cartId,
    userId: shopper.id,
    guestEmail: shopper.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });
}

describe("booking a shipment", () => {
  it("refuses a customer", async () => {
    const placed = await placeTestOrder();
    await expect(bookShipment(shopper, placed.orderId)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("records the tracking reference on the order", async () => {
    const placed = await placeTestOrder();

    const result = await bookShipment(staff, placed.orderId);
    expect(result.trackingReference).toMatch(/^MOCK-/);

    const [order] = await harness.db
      .select({ trackingReference: orders.trackingReference })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(order.trackingReference).toBe(result.trackingReference);
  });

  /** Booking twice must not create a second delivery. */
  it("is idempotent per order", async () => {
    const placed = await placeTestOrder();

    const first = await bookShipment(staff, placed.orderId);
    const second = await bookShipment(staff, placed.orderId);

    expect(second.trackingReference).toBe(first.trackingReference);
    expect(second.reused).toBe(true);
  });

  it("refuses to book for a cancelled order", async () => {
    const placed = await placeTestOrder();
    await advanceOrder(staff, placed.orderId, "cancelled");

    await expect(bookShipment(staff, placed.orderId)).rejects.toThrow(
      ShipmentError,
    );
  });

  it("writes a history entry naming the carrier and reference", async () => {
    const placed = await placeTestOrder();
    const result = await bookShipment(staff, placed.orderId);

    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, placed.orderId));

    const entry = history.find((row) => row.note?.includes("Delivery booked"));
    expect(entry?.note).toContain(result.trackingReference);
    expect(entry?.actorUserId).toBe(staff.id);
  });

  it("copes with a variant that has no weight recorded", async () => {
    const placed = await placeTestOrder(null);
    await expect(bookShipment(staff, placed.orderId)).resolves.toMatchObject({
      reused: false,
    });
  });
});

describe("setting a tracking reference by hand", () => {
  it("refuses a customer", async () => {
    const placed = await placeTestOrder();
    await expect(
      setTrackingReference(shopper, placed.orderId, "SA-123"),
    ).rejects.toThrow(AuthorizationError);
  });

  it("records it and audits the change", async () => {
    const placed = await placeTestOrder();

    await setTrackingReference(staff, placed.orderId, "  SA-123  ");

    const [order] = await harness.db
      .select({ trackingReference: orders.trackingReference })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    // Trimmed, so a stray space never becomes part of the reference.
    expect(order.trackingReference).toBe("SA-123");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, placed.orderId));

    expect(
      entries.some((entry) => entry.action === "order.status_changed"),
    ).toBe(true);
  });

  it("refuses an empty reference", async () => {
    const placed = await placeTestOrder();
    await expect(
      setTrackingReference(staff, placed.orderId, "   "),
    ).rejects.toThrow(ShipmentError);
  });
});

describe("tracking", () => {
  it("returns nothing before a shipment is booked", async () => {
    const placed = await placeTestOrder();
    await expect(trackOrder(placed.orderId)).resolves.toBeNull();
  });

  it("returns the checkpoints from the carrier once booked", async () => {
    const placed = await placeTestOrder();
    await bookShipment(staff, placed.orderId);

    const tracking = await trackOrder(placed.orderId);
    expect(tracking?.carrier).toBe("Mock Courier");
    expect(tracking?.checkpoints.length).toBeGreaterThan(0);
  });
});

describe("internal notes", () => {
  it("refuses a customer", async () => {
    const placed = await placeTestOrder();
    await expect(
      addInternalNote(shopper, placed.orderId, "secret"),
    ).rejects.toThrow(AuthorizationError);
  });

  it("stamps each note with the time and the staff member", async () => {
    const placed = await placeTestOrder();

    await addInternalNote(staff, placed.orderId, "Called the courier.");
    const result = await addInternalNote(staff, placed.orderId, "Rebooked.");

    expect(result.internalNotes).toContain("Called the courier.");
    expect(result.internalNotes).toContain("Rebooked.");
    expect(result.internalNotes).toContain(staff.email);
  });

  /** Internal notes are for staff. A customer query must not carry them. */
  it("never reaches a guest order lookup", async () => {
    const placed = await placeTestOrder();
    await addInternalNote(staff, placed.orderId, "Do not refund again.");

    const [order] = await harness.db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    const guestView = await getGuestOrder(order.orderNumber, shopper.email);
    expect(JSON.stringify(guestView)).not.toContain("Do not refund again.");
  });
});
