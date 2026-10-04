/**
 * What the storefront offers must be something a shopper can actually buy:
 * the homepage's "Windows closing soon" rail lists only windows still open,
 * soonest first, and a variant with no price is neither offered in the buy box
 * nor quoted as a card's "from" price. Nor is a preorder with no capacity or
 * no closing date (D-058), and staff cannot clear either on a live listing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { products, productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, getPublicVariants, listClosingSoon, listProductCards, updateVariant } from "@/lib/catalog";
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

async function preorder(
  title: string,
  variants: { priceBdt: number; closesInHours: number | null; capacity?: number | null }[],
) {
  const product = await createProductForTest(staff, { title, categoryId, status: "preorder_open" });
  const rows = await harness.db
    .insert(productVariants)
    .values(
      variants.map((variant, index) => ({
        productId: product.id,
        sku: `${product.slug}-${index}`.toUpperCase(),
        priceBdt: variant.priceBdt,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: variant.capacity === undefined ? 10 : variant.capacity,
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

describe("a card's remaining capacity", () => {
  it("is not zero for a listing sold from stock, which has no batch to fill", async () => {
    const product = await createProductForTest(staff, { title: "Notebook", categoryId, status: "in_stock" });
    await harness.db.insert(productVariants).values({
      productId: product.id,
      sku: "NOTEBOOK-0",
      priceBdt: 950_00,
      fulfillmentMode: "in_stock",
      stockQuantity: 40,
    });
    const full = await preorder("Full batch", [{ priceBdt: 100_00, closesInHours: 24, capacity: 5 }]);
    await harness.db.update(productVariants).set({ preorderReserved: 5 }).where(eq(productVariants.id, full.variantIds[0]));

    const cards = await listProductCards({ limit: 10 });
    const notebook = cards.find((card) => card.title === "Notebook");
    expect(notebook?.remainingCapacity).toBeNull();
    expect(notebook?.totalCapacity).toBeNull();
    expect(notebook?.outOfStock).toBe(false);
    // A capped batch with every place taken still reads as full.
    expect(cards.find((card) => card.title === "Full batch")?.remainingCapacity).toBe(0);
  });

  /*
   * One option's batch is full; another option is on the shelf. The card is
   * about the product, and the product can be bought.
   */
  it("does not call a product full when another of its variants is in stock", async () => {
    const mixed = await preorder("Mixed offer", [{ priceBdt: 100_00, closesInHours: 24, capacity: 5 }]);
    await harness.db.update(productVariants).set({ preorderReserved: 5 }).where(eq(productVariants.id, mixed.variantIds[0]));
    await harness.db.insert(productVariants).values({
      productId: mixed.id,
      sku: "MIXED-STOCK",
      priceBdt: 120_00,
      fulfillmentMode: "in_stock",
      stockQuantity: 3,
    });

    const card = (await listProductCards({ limit: 10 })).find((entry) => entry.title === "Mixed offer");
    expect(card?.remainingCapacity).toBeNull();
    expect(card?.totalCapacity).toBeNull();
    expect(card?.outOfStock).toBe(false);

    // The shelf empties too: now the full batch is all there is, and it says so.
    await harness.db.update(productVariants).set({ stockQuantity: 0 }).where(eq(productVariants.sku, "MIXED-STOCK"));
    const after = (await listProductCards({ limit: 10 })).find((entry) => entry.title === "Mixed offer");
    expect(after?.remainingCapacity).toBe(0);
  });
});

describe("preorders without a capacity or a closing date", () => {
  it("are not offered in the buy box", async () => {
    const product = await preorder("Lamp", [
      { priceBdt: 100_00, closesInHours: 24, capacity: null },
      { priceBdt: 200_00, closesInHours: null },
      { priceBdt: 300_00, closesInHours: 24 },
    ]);

    const variants = await getPublicVariants(product.id);
    expect(variants.map((variant) => variant.id)).toEqual([product.variantIds[2]]);
  });

  it("do not set a card's from price", async () => {
    await preorder("Lamp", [
      { priceBdt: 100_00, closesInHours: 24, capacity: null },
      { priceBdt: 300_00, closesInHours: 24 },
    ]);
    await preorder("Nothing open", [{ priceBdt: 100_00, closesInHours: null }]);

    const cards = await listProductCards({ limit: 10 });
    expect(cards.find((card) => card.title === "Lamp")?.fromPriceBdt).toBe(300_00);
    expect(cards.find((card) => card.title === "Nothing open")?.fromPriceBdt).toBeNull();
  });

  it("cannot have either cleared while the listing is live", async () => {
    const product = await preorder("Lamp", [{ priceBdt: 100_00, closesInHours: 24 }]);
    const [variantId] = product.variantIds;

    await expect(updateVariant(staff, variantId, { preorderCapacity: null })).rejects.toThrow(
      /capacity and a closing date/,
    );
    await expect(updateVariant(staff, variantId, { preorderClosesAt: null })).rejects.toThrow(
      /capacity and a closing date/,
    );
    const [unchanged] = await harness.db
      .select({ capacity: productVariants.preorderCapacity, closesAt: productVariants.preorderClosesAt })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    expect(unchanged.capacity).toBe(10);
    expect(unchanged.closesAt).not.toBeNull();
  });

  it("can have either cleared on a draft", async () => {
    const product = await preorder("Lamp", [{ priceBdt: 100_00, closesInHours: 24 }]);
    await harness.db.update(products).set({ status: "draft" }).where(eq(products.id, product.id));

    const updated = await updateVariant(staff, product.variantIds[0], { preorderCapacity: null });
    expect(updated.preorderCapacity).toBeNull();
  });
});
