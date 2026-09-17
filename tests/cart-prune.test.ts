/**
 * Unreachable guest carts are pruned (lib/cart, PRODUCTION-READINESS 21.1):
 * a guest cart older than its cookie's lifetime goes with its lines; a newer
 * guest cart and any account's cart stay, however old.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cartItems, carts, categories, products, productVariants, users } from "@/db/schema";
import { pruneUnreachableGuestCarts } from "@/lib/cart";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const DAY = 86_400_000;
const now = new Date("2026-09-20T00:00:00Z");

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

let variantId = "";
let userId = "";

beforeEach(async () => {
  await harness.reset();
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: "c" }).returning();
  const [product] = await harness.db.insert(products).values({ categoryId: category.id, title: "P", slug: "p" }).returning();
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId: product.id, sku: "P-1", priceBdt: 100_00, fulfillmentMode: "in_stock", stockQuantity: 5 })
    .returning();
  variantId = variant.id;
  userId = (await harness.db.insert(users).values({ email: "c@example.com", passwordHash: "x" }).returning())[0].id;
});

async function cart(ageDays: number, owner: "guest" | "account") {
  const [row] = await harness.db
    .insert(carts)
    .values({
      userId: owner === "account" ? userId : null,
      sessionToken: owner === "guest" ? `token-${Math.random()}` : null,
      createdAt: new Date(now.getTime() - ageDays * DAY),
    })
    .returning();
  await harness.db.insert(cartItems).values({ cartId: row.id, variantId, quantity: 1 });
  return row.id;
}

describe("pruneUnreachableGuestCarts", () => {
  it("removes only guest carts past their cookie's lifetime, with their lines", async () => {
    const oldGuest = await cart(90, "guest");
    const recentGuest = await cart(30, "guest");
    const oldAccount = await cart(400, "account");

    expect(await pruneUnreachableGuestCarts(now)).toBe(1);

    const remaining = (await harness.db.select({ id: carts.id }).from(carts)).map((row) => row.id).sort();
    expect(remaining).toEqual([recentGuest, oldAccount].sort());
    expect(await harness.db.select().from(cartItems).where(eq(cartItems.cartId, oldGuest))).toHaveLength(0);
  });

  it("works through more carts than one batch", async () => {
    for (let index = 0; index < 5; index += 1) await cart(100, "guest");
    expect(await pruneUnreachableGuestCarts(now, 2)).toBe(5);
    expect(await harness.db.select().from(carts)).toHaveLength(0);
  });
});
