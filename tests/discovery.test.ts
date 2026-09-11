/**
 * Filters and facets built from the results in front of the shopper.
 *
 * The headline rule: a filter exists because the results carry values for it.
 * RAM is offered over laptops and not over shoes, whichever system the value
 * lives in — a variation option or a category specification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attributeValues,
  attributes,
  productVariants,
  users,
  variantOptionValues,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  countProducts,
  createCategory,
  createCategoryAttribute,
  createProduct,
  discover,
  listFacets,
  listProductCards,
  parseDiscoveryParams,
  sortSignals,
  updateProduct,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let laptopsId = "";
let shoesId = "";
let ramId = "";
let sizeId = "";

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

  laptopsId = (await createCategory(staff, { name: "Laptops", slug: "laptops" })).id;
  shoesId = (await createCategory(staff, { name: "Shoes", slug: "shoes" })).id;

  ramId = (
    await createCategoryAttribute(staff, laptopsId, {
      name: "RAM",
      dataType: "number",
      unit: "GB",
    })
  ).id;
  sizeId = (
    await createCategoryAttribute(staff, shoesId, {
      name: "Size",
      dataType: "select",
      options: ["40", "41", "42"],
    })
  ).id;
});

async function seed(options: {
  title: string;
  categoryId: string;
  specs?: Record<string, string>;
  prices?: number[];
  sale?: number;
}) {
  const product = await createProduct(staff, {
    title: options.title,
    categoryId: options.categoryId,
    status: "preorder_open",
  });
  if (options.specs) {
    await updateProduct(staff, product.id, { attributeValues: options.specs });
  }
  const rows = await harness.db
    .insert(productVariants)
    .values(
      (options.prices ?? [50_000_00]).map((price, index) => ({
        productId: product.id,
        sku: `${product.slug}-${index}`.toUpperCase(),
        priceBdt: price,
        salePriceBdt: index === 0 ? (options.sale ?? null) : null,
        fulfillmentMode: "preorder" as const,
        preorderClosesAt: new Date(Date.now() + 7 * 86_400_000),
      })),
    )
    .returning({ id: productVariants.id });
  return { ...product, variantIds: rows.map((row) => row.id) };
}

describe("dynamic attribute filters", () => {
  beforeEach(async () => {
    await seed({ title: "Light Laptop", categoryId: laptopsId, specs: { [ramId]: "8" } });
    await seed({ title: "Work Laptop", categoryId: laptopsId, specs: { [ramId]: "16" } });
    await seed({ title: "Studio Laptop", categoryId: laptopsId, specs: { [ramId]: "32" } });
    await seed({ title: "Trail Shoe", categoryId: shoesId, specs: { [sizeId]: "41" } });
    await seed({ title: "Road Shoe", categoryId: shoesId, specs: { [sizeId]: "42" } });
  });

  it("offers RAM over laptops and never over shoes", async () => {
    const laptops = await listFacets({ query: "laptop" });
    const shoes = await listFacets({ query: "shoe" });

    expect(laptops.attributes.map((facet) => facet.key)).toEqual(["ram"]);
    expect(shoes.attributes.map((facet) => facet.key)).toEqual(["size"]);
  });

  it("labels numbers with their unit and orders them as numbers", async () => {
    const [ram] = (await listFacets({ query: "laptop" })).attributes;
    expect(ram.values.map((value) => value.label)).toEqual(["8 GB", "16 GB", "32 GB"]);
  });

  it("filters by a value, widens within a key, and counts against the other filters", async () => {
    expect(
      (await listProductCards({ options: { ram: ["16"] } })).map((card) => card.title),
    ).toEqual(["Work Laptop"]);
    expect(await countProducts({ options: { ram: ["16", "32"] } })).toBe(2);

    const [ram] = (await listFacets({ query: "laptop", options: { ram: ["16"] } })).attributes;
    expect(ram.values.find((value) => value.id === "8")?.count).toBe(1);
    expect(ram.values.find((value) => value.id === "16")?.selected).toBe(true);
  });

  it("drops a key it does not know rather than filtering everything out", async () => {
    const filters = await parseDiscoveryParams({ ram: "16", utm_source: "facebook" });
    expect(filters.options).toEqual({ ram: ["16"] });
  });

  it("does not offer a free-text specification as a filter", async () => {
    const notes = await createCategoryAttribute(staff, laptopsId, {
      name: "Notes",
      dataType: "text",
    });
    const product = await seed({ title: "Spare Laptop", categoryId: laptopsId });
    await updateProduct(staff, product.id, {
      attributeValues: { [ramId]: "8", [notes.id]: "Scuffed lid" },
    });

    const keys = (await listFacets({ query: "laptop" })).attributes.map((facet) => facet.key);
    expect(keys).not.toContain("notes");
  });
});

describe("one colour filter across both systems", () => {
  it("matches a variation option and a specification of the same name", async () => {
    const colourSpec = await createCategoryAttribute(staff, shoesId, {
      name: "Color",
      dataType: "color",
    });
    await seed({ title: "Spec Shoe", categoryId: shoesId, specs: { [colourSpec.id]: "Black" } });
    const variantShoe = await seed({ title: "Variant Shoe", categoryId: shoesId });

    const [colour] = await harness.db.insert(attributes).values({ name: "Color" }).returning();
    const [black] = await harness.db
      .insert(attributeValues)
      .values({ attributeId: colour.id, value: "Black" })
      .returning();
    await harness.db.insert(variantOptionValues).values({
      variantId: variantShoe.variantIds[0],
      attributeId: colour.id,
      attributeValueId: black.id,
    });

    expect(
      (await listProductCards({ options: { color: ["black"] } })).map((card) => card.title).sort(),
    ).toEqual(["Spec Shoe", "Variant Shoe"]);
  });
});

describe("price, sales and sorting", () => {
  it("needs one variant inside a price range, not one above and another below", async () => {
    await seed({ title: "Two Prices", categoryId: laptopsId, prices: [100_00, 900_00] });
    expect(await countProducts({ minPriceBdt: 500_00, maxPriceBdt: 600_00 })).toBe(0);
    expect(await countProducts({ minPriceBdt: 800_00, maxPriceBdt: 950_00 })).toBe(1);
  });

  it("finds what is on sale, shows the saving, and sorts by it", async () => {
    await seed({ title: "Full Price", categoryId: laptopsId, prices: [1_000_00] });
    await seed({ title: "Small Saving", categoryId: laptopsId, prices: [1_000_00], sale: 900_00 });
    await seed({ title: "Big Saving", categoryId: laptopsId, prices: [1_000_00], sale: 500_00 });

    expect(await countProducts({ onSale: true })).toBe(2);

    const [first, second] = await listProductCards({ sort: "discount" });
    expect(first).toMatchObject({ title: "Big Saving", listPriceBdt: 1_000_00, discountPercent: 50 });
    expect(second.title).toBe("Small Saving");
    expect((await sortSignals()).discounts).toBe(true);
  });

  it("does not offer best selling or rating before anything has sold or been reviewed", async () => {
    await seed({ title: "Anything", categoryId: laptopsId });
    const signals = await sortSignals();
    expect(signals).toMatchObject({ sales: false, ratings: false });

    const result = await discover({ params: {} });
    const values = result.sorts.map((option) => option.value);
    expect(values).not.toContain("best_selling");
    expect(values).not.toContain("rating");
    expect(values).not.toContain("relevance");
    expect(result.sort).toBe("featured");
    expect(result.facets.ratings).toEqual([]);
  });

  it("offers round price ranges with real counts", async () => {
    await seed({ title: "Cheap", categoryId: laptopsId, prices: [800_00] });
    await seed({ title: "Middle", categoryId: laptopsId, prices: [4_000_00] });
    await seed({ title: "Dear", categoryId: laptopsId, prices: [60_000_00] });

    const { priceBands } = await listFacets({});
    expect(priceBands.reduce((sum, band) => sum + band.count, 0)).toBe(3);
    expect(priceBands[0].minTaka).toBeNull();
    expect(priceBands.at(-1)?.maxTaka).toBeNull();
  });
});

describe("the listing as a whole", () => {
  it("pages, and pulls a page past the end back to the last one", async () => {
    for (let index = 0; index < 5; index++) {
      await seed({ title: `Laptop ${index}`, categoryId: laptopsId });
    }
    const result = await discover({ params: { page: "9" }, pageSize: 2 });
    expect(result).toMatchObject({ total: 5, pageCount: 3, page: 3 });
    expect(result.products).toHaveLength(1);
  });

  it("counts results per shelf for the category filter", async () => {
    await seed({ title: "Laptop A", categoryId: laptopsId });
    await seed({ title: "Shoe A", categoryId: shoesId });
    const result = await discover({ params: { category: "laptops" }, categoryIds: [laptopsId] });

    expect(result.total).toBe(1);
    // The shelf's own facet ignores the shelf filter, so the other one shows.
    expect(result.facets.categoryCounts[shoesId]).toBe(1);
  });

  it("splits a search that finds nothing into the parts that do", async () => {
    await seed({ title: "Travel Laptop", categoryId: laptopsId });
    const result = await discover({ params: { q: "purple laptop" } });

    expect(result.total).toBe(0);
    expect(result.related).toEqual([{ query: "laptop", count: 1 }]);
  });
});
