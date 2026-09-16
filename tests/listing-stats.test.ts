/**
 * The listing read model (migration 0026) stays equal to the orders and
 * reviews it summarises, through every kind of change, and listings sorted
 * from it come out in the same order as sorting from the source rows.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  categories,
  orderItems,
  orders,
  productListingStats,
  products,
  productVariants,
  reviews,
  users,
} from "@/db/schema";
import { listProductCards } from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let buyers: string[] = [];
let addressId = "";
let categoryId = "";
let keySeq = 0;

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
    .values(Array.from({ length: 4 }, (_, index) => ({ email: `buyer${index}@example.com`, passwordHash: "x", role: "customer" })))
    .returning({ id: users.id });
  buyers = rows.map((row) => row.id);
  const [address] = await harness.db
    .insert(addresses)
    .values({ userId: buyers[0], recipientName: "B", phone: "+8801700000000", addressLine1: "1", city: "Dhaka", district: "Dhaka" })
    .returning({ id: addresses.id });
  addressId = address.id;
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: "c" }).returning({ id: categories.id });
  categoryId = category.id;
});

async function product(title: string, createdAt: Date) {
  const [row] = await harness.db
    .insert(products)
    .values({ categoryId, title, slug: title.toLowerCase().replace(/\s+/g, "-"), status: "in_stock", createdAt })
    .returning({ id: products.id });
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId: row.id, sku: `${title}-sku`, priceBdt: 100_00, fulfillmentMode: "in_stock" })
    .returning({ id: productVariants.id });
  return { id: row.id, variantId: variant.id };
}

async function order(status: string, lines: { variantId: string; quantity: number }[]) {
  keySeq += 1;
  const [row] = await harness.db
    .insert(orders)
    .values({
      orderNumber: `ORD-2026-${String(keySeq).padStart(6, "0")}`,
      userId: buyers[0],
      status,
      shippingAddressId: addressId,
      subtotalBdt: 100_00,
      totalBdt: 100_00,
      amountDueNowBdt: 100_00,
      idempotencyKey: `stats-${keySeq}`,
    })
    .returning({ id: orders.id });
  const items = await harness.db
    .insert(orderItems)
    .values(lines.map((line) => ({ orderId: row.id, variantId: line.variantId, titleSnapshot: "x", unitPriceBdt: 100_00, quantity: line.quantity, fulfillmentModeSnapshot: "in_stock" })))
    .returning({ id: orderItems.id });
  return { id: row.id, itemIds: items.map((item) => item.id) };
}

/** The read model must equal a fresh aggregate over the source rows. */
async function expectConsistent() {
  const rows = await harness.client.query<{ id: string; units: number; reviews: number; rating: string | null; s_units: number | null; s_reviews: number | null; s_rating: string | null }>(`
    select p.id,
      coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id = oi.order_id join product_variants v on v.id = oi.variant_id
                where v.product_id = p.id and o.status not in ('placed','cancelled','refunded')), 0)::int as units,
      (select count(*) from reviews r where r.product_id = p.id and r.status = 'approved')::int as reviews,
      (select avg(r.rating) from reviews r where r.product_id = p.id and r.status = 'approved')::text as rating,
      s.units_sold as s_units, s.review_count as s_reviews, s.rating_avg::text as s_rating
    from products p left join product_listing_stats s on s.product_id = p.id`);
  for (const row of rows.rows) {
    expect(row.s_units ?? 0, `units for ${row.id}`).toBe(row.units);
    expect(row.s_reviews ?? 0, `reviews for ${row.id}`).toBe(row.reviews);
    expect(row.s_rating, `rating for ${row.id}`).toBe(row.rating);
  }
}

describe("orders", () => {
  it("counts units only while an order is paid and not unwound", async () => {
    const kettle = await product("Kettle", new Date("2026-01-01"));
    const placed = await order("placed", [{ variantId: kettle.variantId, quantity: 3 }]);
    await expectConsistent();

    await harness.db.update(orders).set({ status: "payment_confirmed" }).where(eq(orders.id, placed.id));
    await expectConsistent();
    const [afterPaid] = await harness.db.select().from(productListingStats).where(eq(productListingStats.productId, kettle.id));
    expect(afterPaid.unitsSold).toBe(3);

    await harness.db.update(orders).set({ trackingReference: "TRK-1" }).where(eq(orders.id, placed.id));
    await harness.db.update(orders).set({ status: "refunded" }).where(eq(orders.id, placed.id));
    await expectConsistent();
  });

  it("follows lines added to and removed from an order that already counts", async () => {
    const lamp = await product("Lamp", new Date("2026-01-02"));
    const radio = await product("Radio", new Date("2026-01-03"));
    const delivered = await order("delivered", [
      { variantId: lamp.variantId, quantity: 2 },
      { variantId: radio.variantId, quantity: 5 },
    ]);
    await expectConsistent();

    await harness.db.delete(orderItems).where(eq(orderItems.id, delivered.itemIds[1]));
    await expectConsistent();
  });

  it("recomputes every product in a bulk status change", async () => {
    const one = await product("One", new Date("2026-01-04"));
    const two = await product("Two", new Date("2026-01-05"));
    await order("placed", [{ variantId: one.variantId, quantity: 1 }]);
    await order("placed", [{ variantId: two.variantId, quantity: 4 }]);

    await harness.db.update(orders).set({ status: "sourcing" });
    await expectConsistent();
  });
});

describe("reviews", () => {
  it("averages approved reviews only, through approval, rejection and deletion", async () => {
    const mug = await product("Mug", new Date("2026-01-06"));
    const bought = await order("delivered", [{ variantId: mug.variantId, quantity: 1 }]);

    const [pending] = await harness.db
      .insert(reviews)
      .values({ productId: mug.id, userId: buyers[0], orderItemId: bought.itemIds[0], rating: 4 })
      .returning({ id: reviews.id });
    await expectConsistent();

    await harness.db.update(reviews).set({ status: "approved" }).where(eq(reviews.id, pending.id));
    await harness.db.insert(reviews).values({ productId: mug.id, userId: buyers[1], orderItemId: bought.itemIds[0], rating: 1, status: "approved" });
    await expectConsistent();

    await harness.db.update(reviews).set({ status: "rejected" }).where(eq(reviews.id, pending.id));
    await expectConsistent();

    await harness.db.delete(reviews).where(eq(reviews.productId, mug.id));
    await expectConsistent();
  });
});

describe("sorting from the read model", () => {
  it("orders best sellers and ratings exactly as the source rows would", async () => {
    const made = [];
    for (let index = 0; index < 6; index += 1) {
      made.push(await product(`Item ${index}`, new Date(Date.UTC(2026, 1, index + 1))));
    }
    // Ties on units and ratings on purpose, so the newest-first tiebreak matters.
    await order("delivered", [{ variantId: made[0].variantId, quantity: 3 }, { variantId: made[1].variantId, quantity: 3 }]);
    await order("payment_confirmed", [{ variantId: made[2].variantId, quantity: 5 }]);
    const reviewed = await order("delivered", [{ variantId: made[3].variantId, quantity: 1 }, { variantId: made[4].variantId, quantity: 1 }]);
    await order("cancelled", [{ variantId: made[5].variantId, quantity: 9 }]);
    await harness.db.insert(reviews).values([
      { productId: made[3].id, userId: buyers[0], orderItemId: reviewed.itemIds[0], rating: 5, status: "approved" },
      { productId: made[4].id, userId: buyers[0], orderItemId: reviewed.itemIds[1], rating: 5, status: "approved" },
      { productId: made[4].id, userId: buyers[1], orderItemId: reviewed.itemIds[1], rating: 3, status: "approved" },
    ]);

    const expected = async (metric: string) =>
      (
        await harness.client.query<{ id: string }>(`
          select p.id from products p
          order by ${metric}, p.created_at desc, p.id asc`)
      ).rows.map((row) => row.id);

    const bestSelling = await expected(`coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id = oi.order_id
      join product_variants v on v.id = oi.variant_id where v.product_id = p.id and o.status not in ('placed','cancelled','refunded')), 0) desc`);
    expect((await listProductCards({ sort: "best_selling", limit: 10 })).map((card) => card.id)).toEqual(bestSelling);

    const rating = await expected(`(select avg(r.rating) from reviews r where r.product_id = p.id and r.status = 'approved') desc nulls last,
      (select count(*) from reviews r where r.product_id = p.id and r.status = 'approved') desc`);
    expect((await listProductCards({ sort: "rating", limit: 10 })).map((card) => card.id)).toEqual(rating);
  });

  it("backfills products that existed before the read model", async () => {
    const shelf = await product("Shelf", new Date("2026-03-01"));
    await order("delivered", [{ variantId: shelf.variantId, quantity: 7 }]);
    await harness.db.delete(productListingStats);

    await harness.db.execute(sql`select refresh_product_listing_stats(array(select id from products))`);

    await expectConsistent();
  });
});
