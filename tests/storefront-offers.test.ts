/**
 * What the storefront offers must be something a shopper can actually buy:
 * the homepage's "Windows closing soon" rail lists only windows still open,
 * soonest first, and a variant with no price is neither offered in the buy box
 * nor quoted as a card's "from" price.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, getPublicVariants, listClosingSoon, listProductCards } from "@/lib/catalog";
import { createProductForTest } from "./helpers/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
const HOUR = 3_600_000;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [user] = await harness.db
    .insert(users)
    .values({ email: staff.email, passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = user.id;
  categoryId = (await createCategory(staff, { name: "Snacks", slug: "snacks" })).id;
});

async function preorder(title: string, variants: { priceBdt: number; closesInHours: number | null }[]) {
  const product = await createProductForTest(staff, { title, categoryId, status: "preorder_open" });
  const rows = await harness.db
    .insert(productVariants)
    .values(
      variants.map((variant, index) => ({
        productId: product.id,
        sku: `${product.slug}-${index}`.toUpperCase(),
        priceBdt: variant.priceBdt,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: 10,
        preorderClosesAt:
          variant.closesInHours === null ? null : new Date(Date.now() + variant.closesInHours * HOUR),
      })),
    )
    .returning({ id: productVariants.id });
  return { ...product, variantIds: rows.map((row) => row.id) };
}

describe("windows closing soon", () => {
  it("lists only windows still open, soonest first", async () => {
    await preorder("Closed yesterday", [{ priceBdt: 100_00, closesInHours: -24 }]);
    await preorder("Closes in a week", [{ priceBdt: 100_00, closesInHours: 24 * 7 }]);
    await preorder("Closes tomorrow", [{ priceBdt: 100_00, closesInHours: 24 }]);
    // One variant closed, another still open: the product is still open.
    await preorder("Half closed", [
      { priceBdt: 100_00, closesInHours: -2 },
      { priceBdt: 100_00, closesInHours: 48 },
    ]);

    const titles = (await listClosingSoon(8)).map((card) => card.title);
    expect(titles).toEqual(["Closes tomorrow", "Half closed", "Closes in a week"]);
  });
});

describe("unpriced variants", () => {
  it("are not offered in the buy box", async () => {
    const product = await preorder("Projector", [
      { priceBdt: 0, closesInHours: 24 },
      { priceBdt: 37_000_00, closesInHours: 24 },
    ]);

    const variants = await getPublicVariants(product.id);
    expect(variants.map((variant) => variant.id)).toEqual([product.variantIds[1]]);
  });

  it("do not set a card's from price", async () => {
    await preorder("Projector", [
      { priceBdt: 0, closesInHours: 24 },
      { priceBdt: 37_000_00, closesInHours: 24 },
    ]);
    await preorder("Nothing priced", [{ priceBdt: 0, closesInHours: 24 }]);

    const cards = await listProductCards({ limit: 10 });
    expect(cards.find((card) => card.title === "Projector")?.fromPriceBdt).toBe(37_000_00);
    expect(cards.find((card) => card.title === "Nothing priced")?.fromPriceBdt).toBeNull();
  });
});
