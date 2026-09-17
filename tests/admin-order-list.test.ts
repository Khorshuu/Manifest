/**
 * The admin order list at scale: keyset paging visits every order exactly
 * once in order (including orders placed in the same instant), walks back to
 * the previous page, and still honours filters and search; the CSV export
 * streams in batches and says the same as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addresses, categories, orderItems, orders, products, productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { exportOrdersCsv } from "@/lib/admin";
import { decodeOrderCursor, encodeOrderCursor, searchOrdersForStaff } from "@/lib/orders";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let staff: SessionUser;
let placed: { id: string; orderNumber: string; placedAt: Date; status: string }[] = [];

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [staffRow, customer] = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "buyer.nadia@example.com", passwordHash: "x", role: "customer", firstName: "Nadia" },
    ])
    .returning({ id: users.id, email: users.email });
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };

  const [address] = await harness.db
    .insert(addresses)
    .values({ userId: customer.id, recipientName: "N", phone: "+8801700000000", addressLine1: "1", city: "Dhaka", district: "Dhaka" })
    .returning({ id: addresses.id });
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: "c" }).returning({ id: categories.id });
  const [product] = await harness.db
    .insert(products)
    .values({ categoryId: category.id, title: "Listed", slug: "listed", status: "preorder_open" })
    .returning({ id: products.id });
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId: product.id, sku: "LIST-1", priceBdt: 100_00, fulfillmentMode: "preorder" })
    .returning({ id: productVariants.id });

  // Eleven orders; three share one instant, so paging must break the tie.
  const base = Date.UTC(2026, 8, 1, 12);
  const instants = [0, 1, 2, 2, 2, 3, 4, 5, 6, 7, 8].map((hour) => new Date(base + hour * 3_600_000));
  placed = await harness.db
    .insert(orders)
    .values(
      instants.map((placedAt, index) => ({
        orderNumber: `ORD-2026-${String(index + 1).padStart(6, "0")}`,
        userId: index % 2 === 0 ? customer.id : null,
        guestEmail: index % 2 === 0 ? null : `guest${index}@example.com`,
        status: index % 3 === 0 ? "delivered" : "placed",
        shippingAddressId: address.id,
        subtotalBdt: (index + 1) * 100_00,
        totalBdt: (index + 1) * 100_00,
        amountDueNowBdt: (index + 1) * 100_00,
        idempotencyKey: `list-${index}`,
        placedAt,
      })),
    )
    .returning({ id: orders.id, orderNumber: orders.orderNumber, placedAt: orders.placedAt, status: orders.status });

  await harness.db.insert(orderItems).values(
    placed.map((order) => ({
      orderId: order.id,
      variantId: variant.id,
      titleSnapshot: "Listed",
      unitPriceBdt: 100_00,
      quantity: 2,
      fulfillmentModeSnapshot: "preorder",
    })),
  );
});

/** Newest first, ties broken by id descending — the order the index keeps. */
function expectedNewest(rows = placed) {
  return [...rows].sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime() || (a.id < b.id ? 1 : -1));
}

async function walk(sort: "newest" | "oldest", filters: { status?: "placed" | "delivered"; q?: string } = {}) {
  const seen: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await searchOrdersForStaff(staff, { ...filters, sort, limit: 3, after: after ? decodeOrderCursor(after) : undefined });
    seen.push(...page.orders.map((order) => order.id));
    after = page.nextCursor;
    if (!after) return { seen, total: page.total };
  }
  throw new Error("paging did not end");
}

describe("keyset paging", () => {
  it("visits every order exactly once, newest first, through a tie", async () => {
    const { seen, total } = await walk("newest");
    expect(total).toBe(11);
    expect(seen).toEqual(expectedNewest().map((order) => order.id));
  });

  /**
   * The database keeps microseconds; a JavaScript Date keeps milliseconds. A
   * cursor built from the Date skipped an order placed in the same millisecond
   * as the last one on a page but a few microseconds earlier.
   */
  it("does not skip orders placed within the same millisecond as a page boundary", async () => {
    await harness.client.exec(`
      update orders set placed_at = timestamptz '2026-09-01 12:00:00.123456+00' where order_number = 'ORD-2026-000001';
      update orders set placed_at = timestamptz '2026-09-01 12:00:00.123200+00' where order_number = 'ORD-2026-000002';
      update orders set placed_at = timestamptz '2026-09-01 12:00:00.123100+00' where order_number = 'ORD-2026-000003';
    `);
    const all = await searchOrdersForStaff(staff, { sort: "newest", limit: 50 });

    for (const sort of ["newest", "oldest"] as const) {
      const expected = sort === "newest" ? all.orders.map((o) => o.id) : [...all.orders].reverse().map((o) => o.id);
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let after: string | null = null;
        for (let guard = 0; guard < 30; guard += 1) {
          const page = await searchOrdersForStaff(staff, { sort, limit, after: after ? decodeOrderCursor(after) : undefined });
          seen.push(...page.orders.map((order) => order.id));
          after = page.nextCursor;
          if (!after) break;
        }
        expect(seen, `${sort}, ${limit} per page`).toEqual(expected);
      }
    }
  });

  it("walks oldest first the same way", async () => {
    const { seen } = await walk("oldest");
    expect(seen).toEqual(expectedNewest().reverse().map((order) => order.id));
  });

  it("goes back to exactly the previous page", async () => {
    const first = await searchOrdersForStaff(staff, { sort: "newest", limit: 3 });
    expect(first.previousCursor).toBeNull();
    const second = await searchOrdersForStaff(staff, { sort: "newest", limit: 3, after: decodeOrderCursor(first.nextCursor) });
    const back = await searchOrdersForStaff(staff, { sort: "newest", limit: 3, before: decodeOrderCursor(second.previousCursor) });

    expect(back.orders.map((order) => order.id)).toEqual(first.orders.map((order) => order.id));
    expect(back.previousCursor).toBeNull();
    expect(back.nextCursor).not.toBeNull();
  });

  it("keeps filters and search while paging", async () => {
    const delivered = await walk("newest", { status: "delivered" });
    expect(delivered.seen).toEqual(expectedNewest(placed.filter((order) => order.status === "delivered")).map((order) => order.id));

    const byCustomer = await walk("newest", { q: "nadia" });
    expect(byCustomer.total).toBe(6);
    expect(byCustomer.seen).toHaveLength(6);
  });

  it("still carries each order's line summary", async () => {
    const page = await searchOrdersForStaff(staff, { limit: 2 });
    expect(page.orders[0]).toMatchObject({ itemCount: 2, lines: 1, firstTitle: "Listed", hasPreorder: true });
  });

  it("pages the total sorts by offset", async () => {
    const top = await searchOrdersForStaff(staff, { sort: "total_desc", limit: 4, offset: 4 });
    expect(top.orders.map((order) => order.totalBdt)).toEqual([700_00, 600_00, 500_00, 400_00]);
    expect(top.nextCursor).toBeNull();
  });

  it("ignores a malformed cursor from the address bar", () => {
    expect(decodeOrderCursor("nonsense")).toBeUndefined();
    expect(decodeOrderCursor("2026-09-01T12:00:00.000Z_not-a-uuid")).toBeUndefined();
    const cursor = { placedAt: new Date("2026-09-01T12:00:00.000Z"), id: placed[0].id };
    expect(decodeOrderCursor(encodeOrderCursor(cursor))).toEqual(cursor);
  });
});

describe("the orders CSV", () => {
  it("streams every order, newest first, with its item count", async () => {
    const csv = await exportOrdersCsv(staff);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Order number,Status,Placed at,Customer email,Items,Subtotal (BDT),Total (BDT),Collected (BDT),Tracking reference");
    expect(lines).toHaveLength(12);
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(expectedNewest().map((order) => order.orderNumber));
    expect(lines[1]).toContain(",2,");
  });
});
