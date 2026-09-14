/**
 * Checkout under real concurrency.
 *
 * The audit reproduced two failures that no existing suite caught: two-line
 * carts holding the same variants in opposite order deadlocked (27 of 40
 * checkouts failed), and simultaneous submissions of one idempotency key
 * returned raw unique-constraint errors. Each scenario here states the rule it
 * protects and asserts both the outcome and the invariant behind it: the
 * reserved count equals what live orders hold.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { addresses, carts, cartItems, orderItems, orders, orderStatusHistory, payments, productVariants, users } from "@/db/schema";
import { advanceOrder, confirmPayment, placeOrder } from "@/lib/orders";
import { CapacityUnavailableError } from "@/lib/preorder";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import { MockPaymentProvider, setPaymentProviderForTesting } from "@/lib/providers/payment";
import { databaseErrorCode } from "@/lib/db-errors";
import type { SessionUser } from "@/lib/auth/session";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
const ROUNDS = 5;

let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let productId = "";
let staff: SessionUser;
let shoppers: { userId: string; email: string; addressId: string }[] = [];
let run = 0;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("checkout_concurrency_test");
  setPaymentProviderForTesting(new MockPaymentProvider());
  setBackgroundDeliveryForTesting(false);

  const { db } = harness;
  const [staffRow] = await db
    .insert(users)
    .values({ email: "staff@example.test", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };

  const customerRows = await db
    .insert(users)
    .values(
      Array.from({ length: 60 }, (_, index) => ({
        email: `shopper${index}@example.test`,
        passwordHash: "x",
        role: "customer",
      })),
    )
    .returning({ id: users.id, email: users.email });

  const addressRows = await db
    .insert(addresses)
    .values(
      customerRows.map((row) => ({
        userId: row.id,
        recipientName: "Racing Shopper",
        phone: "+8801700000000",
        addressLine1: "1 Contention Road",
        city: "Dhaka",
        district: "Dhaka",
      })),
    )
    .returning({ id: addresses.id, userId: addresses.userId });

  shoppers = customerRows.map((row) => ({
    userId: row.id,
    email: row.email,
    addressId: addressRows.find((address) => address.userId === row.id)!.id,
  }));

  const [category] = await db
    .insert(schema.categories)
    .values({ name: "Race", slug: "race" })
    .returning({ id: schema.categories.id });
  const [product] = await db
    .insert(schema.products)
    .values({ categoryId: category.id, title: "Contended Kit", slug: "contended-kit", status: "preorder_open" })
    .returning({ id: schema.products.id });
  productId = product.id;
}, 180_000);

afterAll(async () => {
  if (!available) return;
  setPaymentProviderForTesting(undefined);
  setBackgroundDeliveryForTesting(true);
  await harness.close();
}, 60_000);

async function variant(capacity: number | null) {
  const [row] = await harness.db
    .insert(productVariants)
    .values({
      productId,
      sku: `RACE-${Math.random().toString(36).slice(2, 10)}`,
      priceBdt: 500_00,
      fulfillmentMode: "preorder",
      preorderCapacity: capacity,
      preorderClosesAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: productVariants.id });
  return row.id;
}

/** A cart whose lines were added in exactly this order. */
async function cart(userId: string, lines: { variantId: string; quantity?: number }[]) {
  const [row] = await harness.db.insert(carts).values({ userId }).returning({ id: carts.id });
  const base = Date.now();
  await harness.db.insert(cartItems).values(
    lines.map((line, index) => ({
      cartId: row.id,
      variantId: line.variantId,
      quantity: line.quantity ?? 1,
      addedAt: new Date(base + index * 1000),
    })),
  );
  return row.id;
}

function place(shopper: (typeof shoppers)[number], cartId: string, key?: string) {
  run += 1;
  return placeOrder({
    cartId,
    userId: shopper.userId,
    guestEmail: shopper.email,
    guestPhone: null,
    shippingAddressId: shopper.addressId,
    method: "bkash",
    idempotencyKey: key ?? `race-${run}-${Math.random().toString(36).slice(2)}`,
  });
}

/**
 * Widens the window between one variant's update and the next lock.
 *
 * On a small, fast database two checkouts rarely interleave inside a single
 * round trip, so a real deadlock only showed up sometimes. A test-only trigger
 * that pauses each variant update makes the interleaving certain: locking
 * line by line then deadlocks every time, while taking every lock up front in
 * one statement cannot, however slow the updates are.
 */
async function withSlowVariantWrites(work: () => Promise<void>) {
  await harness.client.unsafe(`
    create or replace function test_slow_variant_write() returns trigger language plpgsql as $$
    begin perform pg_sleep(0.015); return new; end $$;
    drop trigger if exists test_slow_variant_write on product_variants;
    create trigger test_slow_variant_write before update on product_variants
      for each row execute function test_slow_variant_write();
  `);
  try {
    await work();
  } finally {
    await harness.client.unsafe(`drop trigger if exists test_slow_variant_write on product_variants`);
  }
}

function rejectionCodes(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => databaseErrorCode(result.reason) ?? (result.reason as Error).name);
}

/** The invariant: a variant's reserved count is what its live orders hold. */
async function assertReservedMatchesOrders(variantIds: string[]) {
  const reserved = await harness.db
    .select({ id: productVariants.id, reserved: productVariants.preorderReserved })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));

  const held = await harness.db
    .select({
      variantId: orderItems.variantId,
      units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orderItems.variantId, variantIds), inArray(orders.status, ["placed", "payment_confirmed"])))
    .groupBy(orderItems.variantId);

  for (const row of reserved) {
    const units = Number(held.find((entry) => entry.variantId === row.id)?.units ?? 0);
    expect(row.reserved, `reserved slots on ${row.id}`).toBe(units);
  }
}

describe.skipIf(!available)("checkout under real concurrency", () => {
  it("A: 40 two-line carts in the same order all check out", async () => {
    const first = await variant(null);
    const second = await variant(null);
    const attempts = await Promise.all(
      shoppers.slice(0, 40).map(async (shopper) => ({
        shopper,
        cartId: await cart(shopper.userId, [{ variantId: first }, { variantId: second }]),
      })),
    );

    const results = await Promise.allSettled(attempts.map(({ shopper, cartId }) => place(shopper, cartId)));

    expect(rejectionCodes(results)).toEqual([]);
    await assertReservedMatchesOrders([first, second]);
  }, 180_000);

  /*
   * A deadlock needs two transactions to interleave inside a window of one
   * round trip, so a single burst does not always produce one. Five bursts of
   * forty made the unfixed code fail every time it was tried.
   */
  it("B: 40 two-line carts in opposite order do not deadlock (5 rounds)", async () => {
    const codes: string[] = [];
    let fulfilled = 0;

    await withSlowVariantWrites(async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const first = await variant(null);
      const second = await variant(null);
      const attempts = await Promise.all(
        shoppers.slice(0, 40).map(async (shopper, index) => ({
          shopper,
          cartId: await cart(
            shopper.userId,
            index % 2 === 0
              ? [{ variantId: first }, { variantId: second }]
              : [{ variantId: second }, { variantId: first }],
          ),
        })),
      );

      const results = await Promise.allSettled(attempts.map(({ shopper, cartId }) => place(shopper, cartId)));
      codes.push(...rejectionCodes(results));
      fulfilled += results.filter((result) => result.status === "fulfilled").length;
      await assertReservedMatchesOrders([first, second]);
    }
    });

    expect(codes).toEqual([]);
    expect(fulfilled).toBe(40 * ROUNDS);
  }, 300_000);

  it("C: 30 shoppers for 5 slots produce 5 orders and 25 clean refusals", async () => {
    const limited = await variant(5);
    const attempts = await Promise.all(
      shoppers.slice(0, 30).map(async (shopper) => ({
        shopper,
        cartId: await cart(shopper.userId, [{ variantId: limited }]),
      })),
    );

    const results = await Promise.allSettled(attempts.map(({ shopper, cartId }) => place(shopper, cartId)));
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(refused).toHaveLength(25);
    for (const failure of refused) expect(failure.reason).toBeInstanceOf(CapacityUnavailableError);
    await assertReservedMatchesOrders([limited]);
  }, 180_000);

  it("D: ten simultaneous submissions of one key resolve to one order", async () => {
    const item = await variant(10);
    const shopper = shoppers[45];
    const cartId = await cart(shopper.userId, [{ variantId: item, quantity: 2 }]);
    const key = `same-key-${Date.now()}`;

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => place(shopper, cartId, key)));

    expect(rejectionCodes(results)).toEqual([]);
    const ids = new Set(results.map((result) => (result as PromiseFulfilledResult<{ orderId: string }>).value.orderId));
    expect(ids.size).toBe(1);

    const [orderId] = [...ids];
    await expect(harness.db.select().from(orders).where(eq(orders.idempotencyKey, key))).resolves.toHaveLength(1);
    await expect(harness.db.select().from(payments).where(eq(payments.orderId, orderId))).resolves.toHaveLength(1);
    await assertReservedMatchesOrders([item]);
  }, 180_000);

  it("E: a payment confirmation replayed concurrently confirms once", async () => {
    const item = await variant(10);
    const shopper = shoppers[46];
    const placed = await place(shopper, await cart(shopper.userId, [{ variantId: item }]));
    const [payment] = await harness.db
      .select({ providerRef: payments.providerRef })
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => confirmPayment(payment.providerRef!)));

    expect(rejectionCodes(results)).toEqual([]);
    const history = await harness.db
      .select()
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, placed.orderId), eq(orderStatusHistory.status, "payment_confirmed")));
    expect(history).toHaveLength(1);
  }, 180_000);

  it("F: a cancellation releasing a slot races new checkouts without overselling", async () => {
    const scarce = await variant(1);
    const holder = shoppers[47];
    const held = await place(holder, await cart(holder.userId, [{ variantId: scarce }]));

    const racers = await Promise.all(
      shoppers.slice(0, 10).map(async (shopper) => ({
        shopper,
        cartId: await cart(shopper.userId, [{ variantId: scarce }]),
      })),
    );

    const results = await Promise.allSettled([
      advanceOrder(staff, held.orderId, "cancelled", "race"),
      ...racers.map(({ shopper, cartId }) => place(shopper, cartId)),
    ]);

    const unexpected = rejectionCodes(results).filter((code) => code !== "CapacityUnavailableError");
    expect(unexpected).toEqual([]);
    await assertReservedMatchesOrders([scarce]);
  }, 180_000);

  it("H: three-line carts in every permutation over shared limited variants (5 rounds)", async () => {
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    const unexpected: string[] = [];

    await withSlowVariantWrites(async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const variants = [await variant(12), await variant(12), await variant(12)];
      const attempts = await Promise.all(
        shoppers.slice(0, 36).map(async (shopper, index) => ({
          shopper,
          cartId: await cart(
            shopper.userId,
            permutations[index % 6].map((position) => ({ variantId: variants[position] })),
          ),
        })),
      );

      const results = await Promise.allSettled(attempts.map(({ shopper, cartId }) => place(shopper, cartId)));

      // Twelve slots each, so exactly twelve three-line carts fit; the rest
      // are refused cleanly, never with a deadlock or a raw database error.
      unexpected.push(...rejectionCodes(results).filter((code) => code !== "CapacityUnavailableError"));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
      await assertReservedMatchesOrders(variants);
    }
    });

    expect(unexpected).toEqual([]);
  }, 300_000);
});

describe.skipIf(available)("checkout concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
