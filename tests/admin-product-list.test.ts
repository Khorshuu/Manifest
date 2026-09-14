/**
 * Admin → Products on the server: the same live/draft/archived and
 * in-stock/low/out/none rules the browser used to apply, now filtering,
 * sorting, counting and paging in SQL.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { categories, productImages, products, productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { searchProductsForAdmin } from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let staff: SessionUser;
let customer: SessionUser;
let audioId = "";
let kitchenId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

async function product(key: string, values: Partial<typeof products.$inferInsert>, variants: Partial<typeof productVariants.$inferInsert>[]) {
  const [row] = await harness.db
    .insert(products)
    .values({ categoryId: audioId, title: key, slug: key.toLowerCase().replace(/\s+/g, "-"), status: "in_stock", ...values })
    .returning({ id: products.id });
  ids[key] = row.id;
  for (const [index, variant] of variants.entries()) {
    await harness.db.insert(productVariants).values({
      productId: row.id,
      sku: `${key.replace(/\s+/g, "").toUpperCase()}-${index}`,
      priceBdt: 1_000_00,
      fulfillmentMode: "in_stock",
      ...variant,
    });
  }
}

beforeEach(async () => {
  await harness.reset();
  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email, role: users.role });
  const staffRow = rows.find((row) => row.role === "staff_admin")!;
  staff = { id: staffRow.id, email: staffRow.email, role: "staff_admin" };
  const customerRow = rows.find((row) => row.role === "customer")!;
  customer = { id: customerRow.id, email: customerRow.email, role: "customer" };

  const [audio, kitchen] = await harness.db
    .insert(categories)
    .values([
      { name: "Audio", slug: "audio" },
      { name: "Kitchen", slug: "kitchen" },
    ])
    .returning({ id: categories.id });
  audioId = audio.id;
  kitchenId = kitchen.id;

  const day = (n: number) => new Date(Date.UTC(2026, 8, n));

  await product("Plenty Speaker", { brand: "Acoustica", updatedAt: day(6), createdAt: day(1) }, [
    { priceBdt: 3_000_00, stockQuantity: 20 },
  ]);
  await product("Nearly Gone Kettle", { categoryId: kitchenId, status: "preorder_open", updatedAt: day(5), createdAt: day(2) }, [
    { priceBdt: 1_500_00, fulfillmentMode: "preorder", preorderCapacity: 10, preorderReserved: 8 },
  ]);
  await product("Unfinished Draft", { status: "draft", updatedAt: day(4), createdAt: day(3) }, []);
  await product("Empty Shelf Lamp", { sku: "LAMP-900", updatedAt: day(3), createdAt: day(4) }, [
    { priceBdt: 900_00, stockQuantity: 0 },
  ]);
  await product("Retired Radio", { status: "archived", archivedAt: day(2), updatedAt: day(2), createdAt: day(5) }, [
    { priceBdt: 500_00, stockQuantity: 5 },
  ]);
  await product("Open Batch Headphones", { status: "preorder_open", brand: "Acoustica", updatedAt: day(1), createdAt: day(6) }, [
    { priceBdt: 2_000_00, fulfillmentMode: "preorder", preorderCapacity: null },
  ]);

  await harness.db.insert(productImages).values([
    { productId: ids["Plenty Speaker"], url: "/second.jpg", altText: "b", sortOrder: 1, kind: "gallery" },
    { productId: ids["Plenty Speaker"], url: "/first.jpg", altText: "a", sortOrder: 0, kind: "gallery" },
  ]);
});

const titles = (result: Awaited<ReturnType<typeof searchProductsForAdmin>>) => result.rows.map((row) => row.title);

describe("summary counts", () => {
  it("counts the shop the way the cards describe it", async () => {
    const result = await searchProductsForAdmin(staff);
    expect(result.counts).toEqual({ all: 5, published: 4, drafts: 1, out: 1, low: 1, archived: 1 });
    expect(result.total).toBe(5);
  });
});

describe("filters", () => {
  it("hides archived products unless asked for them", async () => {
    expect(titles(await searchProductsForAdmin(staff))).not.toContain("Retired Radio");
    expect(titles(await searchProductsForAdmin(staff, { status: "archived" }))).toEqual(["Retired Radio"]);
  });

  it("separates published from drafts", async () => {
    expect(titles(await searchProductsForAdmin(staff, { status: "draft" }))).toEqual(["Unfinished Draft"]);
    expect(await searchProductsForAdmin(staff, { status: "published" })).toMatchObject({ total: 4 });
  });

  it("classifies inventory, counting low stock as in stock", async () => {
    const byTitle = new Map((await searchProductsForAdmin(staff)).rows.map((row) => [row.title, row.inventory]));
    expect(Object.fromEntries(byTitle)).toEqual({
      "Plenty Speaker": "in_stock",
      "Nearly Gone Kettle": "low",
      "Unfinished Draft": "none",
      "Empty Shelf Lamp": "out",
      "Open Batch Headphones": "in_stock",
    });
    expect(titles(await searchProductsForAdmin(staff, { stock: "out" }))).toEqual(["Empty Shelf Lamp"]);
    expect(titles(await searchProductsForAdmin(staff, { stock: "low" }))).toEqual(["Nearly Gone Kettle"]);
    expect((await searchProductsForAdmin(staff, { stock: "in_stock" })).total).toBe(3);
  });

  it("searches name, brand and SKU, and filters by category", async () => {
    expect(titles(await searchProductsForAdmin(staff, { q: "acoustica", sort: "name_asc" }))).toEqual([
      "Open Batch Headphones",
      "Plenty Speaker",
    ]);
    // The product's own SKU, as the list has always searched.
    expect(titles(await searchProductsForAdmin(staff, { q: "lamp-900" }))).toEqual(["Empty Shelf Lamp"]);
    expect(titles(await searchProductsForAdmin(staff, { categoryId: kitchenId }))).toEqual(["Nearly Gone Kettle"]);
    // A malformed category id is ignored rather than breaking the query.
    expect((await searchProductsForAdmin(staff, { categoryId: "not-a-uuid" })).total).toBe(5);
  });
});

describe("sorting and paging", () => {
  it("sorts by recent update by default and by price or stock on request", async () => {
    expect(titles(await searchProductsForAdmin(staff))[0]).toBe("Plenty Speaker");
    expect(titles(await searchProductsForAdmin(staff, { sort: "price_asc" }))).toEqual([
      "Empty Shelf Lamp",
      "Nearly Gone Kettle",
      "Open Batch Headphones",
      "Plenty Speaker",
      "Unfinished Draft",
    ]);
    const byStock = titles(await searchProductsForAdmin(staff, { sort: "stock_asc" }));
    expect(byStock.at(-1)).toBe("Open Batch Headphones");
  });

  it("returns one page at a time and clamps a page past the end", async () => {
    const second = await searchProductsForAdmin(staff, { pageSize: 2, page: 2 });
    expect(second).toMatchObject({ total: 5, page: 2, pageCount: 3 });
    expect(second.rows).toHaveLength(2);

    const beyond = await searchProductsForAdmin(staff, { pageSize: 2, page: 99 });
    expect(beyond.page).toBe(3);
    expect(beyond.rows).toHaveLength(1);
  });

  it("carries each product's first gallery photograph and variant figures", async () => {
    const [speaker] = (await searchProductsForAdmin(staff, { q: "Plenty" })).rows;
    expect(speaker).toMatchObject({ imageUrl: "/first.jpg", variantCount: 1, minPriceBdt: 3_000_00, stockOnHand: 20, live: true });
  });
});

describe("access", () => {
  it("refuses a customer", async () => {
    await expect(searchProductsForAdmin(customer)).rejects.toThrow();
  });

  it("reflects a change made a moment ago", async () => {
    await harness.db.update(products).set({ status: "draft" }).where(eq(products.id, ids["Plenty Speaker"]));
    expect((await searchProductsForAdmin(staff)).counts.drafts).toBe(2);
  });
});
