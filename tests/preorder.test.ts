/**
 * Preorder capacity rules against a real (in-process) Postgres.
 *
 * True concurrency is covered separately in tests/preorder-concurrency.test.ts,
 * which needs a multi-connection server; PGlite serves one connection, so it
 * can prove the rules but not the race.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { productVariants, users, waitlistEntries } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  CapacityUnavailableError,
  closePreorder,
  countWaitlist,
  extendPreorder,
  getAvailability,
  joinWaitlist,
  listNearCapacity,
  openPreorder,
  PreorderWindowError,
  releaseCapacityStandalone,
  reserveCapacityStandalone,
  VariantNotFoundError,
} from "@/lib/preorder";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "customer@example.com",
  role: "customer",
};

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "customer@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, role: users.role });

  staff.id = rows.find((r) => r.role === "staff_admin")!.id;
  customer.id = rows.find((r) => r.role === "customer")!.id;
});

const HOUR = 60 * 60 * 1000;

async function seedVariant(
  overrides: Partial<{
    fulfillmentMode: "in_stock" | "preorder";
    preorderCapacity: number | null;
    preorderReserved: number;
    preorderClosesAt: Date | null;
    stockQuantity: number | null;
    isEnabled: boolean;
    archivedAt: Date | null;
  }> = {},
) {
  // Unique per call: a single test may seed several variants.
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Audio ${suffix}`,
    slug: `audio-${suffix}`,
  });
  const product = await createProduct(staff, {
    title: `Headphones ${suffix}`,
    categoryId: category.id,
  });

  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      priceBdt: 100_00,
      fulfillmentMode: overrides.fulfillmentMode ?? "preorder",
      preorderCapacity:
        overrides.preorderCapacity === undefined ? 10 : overrides.preorderCapacity,
      preorderReserved: overrides.preorderReserved ?? 0,
      preorderClosesAt:
        overrides.preorderClosesAt === undefined
          ? new Date(Date.now() + 24 * HOUR)
          : overrides.preorderClosesAt,
      stockQuantity: overrides.stockQuantity ?? null,
      isEnabled: overrides.isEnabled ?? true,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning();

  return variant;
}

async function reservedCount(variantId: string) {
  const [row] = await harness.db
    .select({ reserved: productVariants.preorderReserved })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return row.reserved;
}

describe("getAvailability", () => {
  it("reports the remaining slots on an open preorder", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderReserved: 4,
    });

    const availability = await getAvailability(variant.id);
    expect(availability.remaining).toBe(6);
    expect(availability.isPurchasable).toBe(true);
    expect(availability.reason).toBe("available");
  });

  it("reports a full preorder as sold out", async () => {
    const variant = await seedVariant({
      preorderCapacity: 5,
      preorderReserved: 5,
    });

    const availability = await getAvailability(variant.id);
    expect(availability.remaining).toBe(0);
    expect(availability.isPurchasable).toBe(false);
    expect(availability.reason).toBe("sold_out");
  });

  it("reports a window that has already closed", async () => {
    const variant = await seedVariant({
      preorderClosesAt: new Date(Date.now() - HOUR),
    });

    const availability = await getAvailability(variant.id);
    expect(availability.isPurchasable).toBe(false);
    expect(availability.reason).toBe("window_closed");
  });

  it("treats a disabled variant as unavailable", async () => {
    const variant = await seedVariant({ isEnabled: false });
    const availability = await getAvailability(variant.id);
    expect(availability.reason).toBe("disabled");
  });

  it("treats an archived variant as unavailable", async () => {
    const variant = await seedVariant({ archivedAt: new Date() });
    const availability = await getAvailability(variant.id);
    expect(availability.reason).toBe("archived");
  });

  it("has no ceiling when a preorder sets no capacity", async () => {
    const variant = await seedVariant({ preorderCapacity: null });
    const availability = await getAvailability(variant.id);
    expect(availability.remaining).toBeNull();
    expect(availability.isPurchasable).toBe(true);
  });

  it("uses stock, not capacity, for an in-stock variant", async () => {
    const variant = await seedVariant({
      fulfillmentMode: "in_stock",
      stockQuantity: 3,
      preorderCapacity: null,
      preorderClosesAt: null,
    });

    const availability = await getAvailability(variant.id);
    expect(availability.remaining).toBe(3);
    expect(availability.reason).toBe("available");
  });

  it("reports an in-stock variant with no stock as out of stock", async () => {
    const variant = await seedVariant({
      fulfillmentMode: "in_stock",
      stockQuantity: 0,
      preorderCapacity: null,
      preorderClosesAt: null,
    });

    const availability = await getAvailability(variant.id);
    expect(availability.reason).toBe("out_of_stock");
  });

  it("raises for a variant that does not exist", async () => {
    await expect(
      getAvailability("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(VariantNotFoundError);
  });
});

describe("reserveCapacity", () => {
  it("increments the reserved count", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });

    const result = await reserveCapacityStandalone(variant.id, 3);

    expect(result.remainingAfter).toBe(7);
    await expect(reservedCount(variant.id)).resolves.toBe(3);
  });

  it("allows taking exactly the remaining slots", async () => {
    const variant = await seedVariant({
      preorderCapacity: 5,
      preorderReserved: 3,
    });

    await expect(reserveCapacityStandalone(variant.id, 2)).resolves.toMatchObject(
      { remainingAfter: 0 },
    );
    await expect(reservedCount(variant.id)).resolves.toBe(5);
  });

  it("refuses more than remains, and changes nothing", async () => {
    const variant = await seedVariant({
      preorderCapacity: 5,
      preorderReserved: 3,
    });

    await expect(reserveCapacityStandalone(variant.id, 3)).rejects.toThrow(
      CapacityUnavailableError,
    );
    await expect(reservedCount(variant.id)).resolves.toBe(3);
  });

  it("refuses a closed window even when slots remain", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderReserved: 0,
      preorderClosesAt: new Date(Date.now() - HOUR),
    });

    await expect(reserveCapacityStandalone(variant.id, 1)).rejects.toThrow(
      /closed/i,
    );
    await expect(reservedCount(variant.id)).resolves.toBe(0);
  });

  it("refuses a disabled variant", async () => {
    const variant = await seedVariant({ isEnabled: false });
    await expect(reserveCapacityStandalone(variant.id, 1)).rejects.toThrow(
      CapacityUnavailableError,
    );
  });

  it("decrements stock for an in-stock variant", async () => {
    const variant = await seedVariant({
      fulfillmentMode: "in_stock",
      stockQuantity: 4,
      preorderCapacity: null,
      preorderClosesAt: null,
    });

    await reserveCapacityStandalone(variant.id, 3);

    const [row] = await harness.db
      .select({ stock: productVariants.stockQuantity })
      .from(productVariants)
      .where(eq(productVariants.id, variant.id));
    expect(row.stock).toBe(1);
  });

  it("rejects a zero or negative quantity", async () => {
    const variant = await seedVariant();
    await expect(reserveCapacityStandalone(variant.id, 0)).rejects.toThrow();
    await expect(reserveCapacityStandalone(variant.id, -1)).rejects.toThrow();
  });

  /**
   * The whole point of taking the reservation inside the caller's transaction:
   * if the order fails to write, the slot must not stay held.
   */
  it("gives the slot back when the surrounding transaction fails", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });

    await expect(
      db.transaction(async (tx) => {
        const { reserveCapacity } = await import("@/lib/preorder/capacity");
        await reserveCapacity(tx, variant.id, 2);
        throw new Error("the order failed to write");
      }),
    ).rejects.toThrow("the order failed to write");

    await expect(reservedCount(variant.id)).resolves.toBe(0);
  });
});

describe("releaseCapacity", () => {
  it("returns slots to the pool", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderReserved: 6,
    });

    await releaseCapacityStandalone(variant.id, 2);
    await expect(reservedCount(variant.id)).resolves.toBe(4);
  });

  /**
   * A double release must not drive the count negative, which would let the
   * variant oversell later.
   */
  it("never drives the reserved count below zero", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderReserved: 1,
    });

    await releaseCapacityStandalone(variant.id, 5);
    await expect(reservedCount(variant.id)).resolves.toBe(0);
  });

  it("returns stock for an in-stock variant", async () => {
    const variant = await seedVariant({
      fulfillmentMode: "in_stock",
      stockQuantity: 2,
      preorderCapacity: null,
      preorderClosesAt: null,
    });

    await releaseCapacityStandalone(variant.id, 3);

    const [row] = await harness.db
      .select({ stock: productVariants.stockQuantity })
      .from(productVariants)
      .where(eq(productVariants.id, variant.id));
    expect(row.stock).toBe(5);
  });
});

describe("waitlist", () => {
  it("records an entry when a preorder is full", async () => {
    const variant = await seedVariant({
      preorderCapacity: 1,
      preorderReserved: 1,
    });

    const result = await joinWaitlist(variant.id, "shopper@example.com");
    expect(result.alreadyOnList).toBe(false);
    await expect(countWaitlist(variant.id)).resolves.toBe(1);
  });

  it("does not add the same person twice", async () => {
    const variant = await seedVariant({
      preorderCapacity: 1,
      preorderReserved: 1,
    });

    await joinWaitlist(variant.id, "shopper@example.com");
    const second = await joinWaitlist(variant.id, "shopper@example.com");

    expect(second.alreadyOnList).toBe(true);
    await expect(countWaitlist(variant.id)).resolves.toBe(1);
  });

  it("counts only people still waiting", async () => {
    const variant = await seedVariant();
    await joinWaitlist(variant.id, "first@example.com");
    await joinWaitlist(variant.id, "second@example.com");

    await harness.db
      .update(waitlistEntries)
      .set({ notifiedAt: new Date() })
      .where(eq(waitlistEntries.email, "first@example.com"));

    await expect(countWaitlist(variant.id)).resolves.toBe(1);
  });
});

describe("preorder window", () => {
  it("refuses a customer opening a preorder", async () => {
    const variant = await seedVariant();
    await expect(
      openPreorder(customer, variant.id, { capacity: 10, closesAt: null }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses capacity below what is already reserved", async () => {
    const variant = await seedVariant({
      preorderCapacity: 20,
      preorderReserved: 12,
    });

    await expect(
      openPreorder(staff, variant.id, { capacity: 5, closesAt: null }),
    ).rejects.toThrow(PreorderWindowError);
  });

  it("refuses a closing date in the past", async () => {
    const variant = await seedVariant();
    await expect(
      openPreorder(staff, variant.id, {
        capacity: 10,
        closesAt: new Date(Date.now() - HOUR),
      }),
    ).rejects.toThrow(/future/);
  });

  it("closing now makes the variant unpurchasable", async () => {
    const variant = await seedVariant({ preorderCapacity: 10 });

    await closePreorder(staff, variant.id);

    const availability = await getAvailability(variant.id);
    expect(availability.isPurchasable).toBe(false);
    expect(availability.reason).toBe("window_closed");
  });

  /** Closing must not disturb slots that are already sold. */
  it("closing leaves reserved slots alone", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderReserved: 7,
    });

    await closePreorder(staff, variant.id);
    await expect(reservedCount(variant.id)).resolves.toBe(7);
  });

  it("extending reopens a window that had closed", async () => {
    const variant = await seedVariant({
      preorderCapacity: 10,
      preorderClosesAt: new Date(Date.now() - HOUR),
    });

    await expect(getAvailability(variant.id)).resolves.toMatchObject({
      reason: "window_closed",
    });

    await extendPreorder(staff, variant.id, new Date(Date.now() + 48 * HOUR));

    await expect(getAvailability(variant.id)).resolves.toMatchObject({
      reason: "available",
    });
  });

  it("refuses to extend into the past", async () => {
    const variant = await seedVariant();
    await expect(
      extendPreorder(staff, variant.id, new Date(Date.now() - HOUR)),
    ).rejects.toThrow(/future/);
  });

  it("lists variants near capacity for the dashboard alert", async () => {
    await seedVariant({ preorderCapacity: 10, preorderReserved: 9 });
    await seedVariant({ preorderCapacity: 10, preorderReserved: 1 });

    const near = await listNearCapacity(staff, 0.8);
    expect(near).toHaveLength(1);
    expect(near[0].reserved).toBe(9);
  });

  it("refuses a customer reading the capacity alert list", async () => {
    await expect(listNearCapacity(customer)).rejects.toThrow(AuthorizationError);
  });
});
