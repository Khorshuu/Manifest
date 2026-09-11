/**
 * Faceted filtering and autosuggest.
 *
 * The rule that matters most here is unglamorous: the count and the listing are
 * built from the same conditions. A "42 products" label above 12 rows is a bug
 * a shopper notices immediately, and this codebase had exactly that — the old
 * count ignored the brand filter.
 */
import { eq } from "drizzle-orm";
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
  createProduct,
  hasActiveFilters,
  listFacets,
  listProductCards,
  parseFilterParams,
  suggestSearch,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

let categoryId = "";
let colourValues: Record<string, string> = {};
let sizeValues: Record<string, string> = {};

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
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = user.id;

  const category = await createCategory(staff, {
    name: "Snacks",
    slug: "snacks",
  });
  categoryId = category.id;

  const [colour, size] = await harness.db
    .insert(attributes)
    .values([{ name: "Colour" }, { name: "Size" }])
    .returning({ id: attributes.id, name: attributes.name });

  const values = await harness.db
    .insert(attributeValues)
    .values([
      { attributeId: colour.id, value: "Red", sortOrder: 0 },
      { attributeId: colour.id, value: "Blue", sortOrder: 1 },
      { attributeId: size.id, value: "Large", sortOrder: 0 },
      { attributeId: size.id, value: "Small", sortOrder: 1 },
    ])
    .returning({
      id: attributeValues.id,
      value: attributeValues.value,
      attributeId: attributeValues.attributeId,
    });

  colourValues = Object.fromEntries(
    values
      .filter((row) => row.attributeId === colour.id)
      .map((row) => [row.value, row.id]),
  );
  sizeValues = Object.fromEntries(
    values
      .filter((row) => row.attributeId === size.id)
      .map((row) => [row.value, row.id]),
  );
});

/** One product, one variant, with the given option values attached. */
async function seedProduct(options: {
  title: string;
  brand?: string;
  priceBdt: number;
  fulfillment?: "preorder" | "in_stock";
  stock?: number;
  capacity?: number | null;
  reserved?: number;
  values?: string[];
}) {
  const product = await createProduct(staff, {
    title: options.title,
    categoryId,
    brand: options.brand,
    status: "preorder_open",
  });

  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      priceBdt: options.priceBdt,
      fulfillmentMode: options.fulfillment ?? "preorder",
      stockQuantity: options.stock ?? 0,
      preorderCapacity: options.capacity ?? null,
      preorderReserved: options.reserved ?? 0,
      preorderClosesAt:
        (options.fulfillment ?? "preorder") === "preorder"
          ? new Date(Date.now() + 86_400_000)
          : null,
    })
    .returning({ id: productVariants.id });

  for (const valueId of options.values ?? []) {
    const [row] = await harness.db
      .select({ attributeId: attributeValues.attributeId })
      .from(attributeValues)
      .where(eq(attributeValues.id, valueId));

    await harness.db.insert(variantOptionValues).values({
      variantId: variant.id,
      attributeId: row.attributeId,
      attributeValueId: valueId,
    });
  }

  return { productId: product.id, variantId: variant.id };
}

describe("the count matches the listing", () => {
  it("agrees with the listing for every filter", async () => {
    await seedProduct({ title: "Red candy", brand: "Acme", priceBdt: 100_00 });
    await seedProduct({ title: "Blue candy", brand: "Other", priceBdt: 900_00 });

    for (const filters of [
      {},
      { brands: ["Acme"] },
      { minPriceBdt: 500_00 },
      { maxPriceBdt: 200_00 },
      { query: "candy" },
      { brands: ["Acme"], maxPriceBdt: 200_00 },
    ]) {
      const listed = await listProductCards({ ...filters, limit: 100 });
      const counted = await countProducts(filters);

      expect(counted, JSON.stringify(filters)).toBe(listed.length);
    }
  });
});

describe("filtering", () => {
  it("filters by brand", async () => {
    await seedProduct({ title: "One", brand: "Acme", priceBdt: 100_00 });
    await seedProduct({ title: "Two", brand: "Other", priceBdt: 100_00 });

    const rows = await listProductCards({ brands: ["Acme"] });
    expect(rows.map((row) => row.title)).toEqual(["One"]);
  });

  it("filters by price range against the variant price", async () => {
    await seedProduct({ title: "Cheap", priceBdt: 100_00 });
    await seedProduct({ title: "Dear", priceBdt: 900_00 });

    const rows = await listProductCards({
      minPriceBdt: 500_00,
      maxPriceBdt: 1000_00,
    });

    expect(rows.map((row) => row.title)).toEqual(["Dear"]);
  });

  it("filters by fulfillment mode", async () => {
    await seedProduct({ title: "Preorder", priceBdt: 100_00 });
    await seedProduct({
      title: "Stocked",
      priceBdt: 100_00,
      fulfillment: "in_stock",
      stock: 5,
    });

    const rows = await listProductCards({ fulfillment: "in_stock" });
    expect(rows.map((row) => row.title)).toEqual(["Stocked"]);
  });

  /** A full preorder is still listed, unless someone asks for what they can buy. */
  it("hides what cannot be bought when asked", async () => {
    await seedProduct({
      title: "Full",
      priceBdt: 100_00,
      capacity: 5,
      reserved: 5,
    });
    await seedProduct({
      title: "Open",
      priceBdt: 100_00,
      capacity: 5,
      reserved: 1,
    });

    expect((await listProductCards({})).length).toBe(2);

    const rows = await listProductCards({ availableOnly: true });
    expect(rows.map((row) => row.title)).toEqual(["Open"]);
  });

  it("widens within one attribute and narrows across two", async () => {
    await seedProduct({
      title: "Red large",
      priceBdt: 100_00,
      values: [colourValues.Red, sizeValues.Large],
    });
    await seedProduct({
      title: "Blue small",
      priceBdt: 100_00,
      values: [colourValues.Blue, sizeValues.Small],
    });

    // Two colours: both, because values of one attribute are OR-ed.
    const eitherColour = await listProductCards({
      valueIds: [colourValues.Red, colourValues.Blue],
    });
    expect(eitherColour).toHaveLength(2);

    // Red AND small: neither product is both.
    const crossed = await listProductCards({
      valueIds: [colourValues.Red, sizeValues.Small],
    });
    expect(crossed).toHaveLength(0);
  });
});

describe("facet counts", () => {
  it("counts a product once even with several matching variants", async () => {
    const { productId } = await seedProduct({
      title: "Two variants",
      priceBdt: 100_00,
      values: [colourValues.Red],
    });

    // A second variant carrying the same colour.
    const [second] = await harness.db
      .insert(productVariants)
      .values({
        productId,
        sku: "SKU-SECOND",
        priceBdt: 150_00,
        fulfillmentMode: "preorder",
      })
      .returning({ id: productVariants.id });

    const [colour] = await harness.db
      .select({ attributeId: attributeValues.attributeId })
      .from(attributeValues)
      .where(eq(attributeValues.id, colourValues.Red));

    await harness.db.insert(variantOptionValues).values({
      variantId: second.id,
      attributeId: colour.attributeId,
      attributeValueId: colourValues.Red,
    });

    // A second colour in the results, so the filter has something to choose
    // between — an attribute with one value is not offered as a filter.
    await seedProduct({
      title: "Blue one",
      priceBdt: 100_00,
      values: [colourValues.Blue],
    });

    const facets = await listFacets({});
    const red = facets.attributes
      .flatMap((attribute) => attribute.values)
      .find((value) => value.label === "Red");

    expect(red?.count).toBe(1);
  });

  it("marks what is currently selected", async () => {
    await seedProduct({
      title: "Red",
      priceBdt: 100_00,
      values: [colourValues.Red],
    });

    const facets = await listFacets({ valueIds: [colourValues.Red] });
    const red = facets.attributes
      .flatMap((attribute) => attribute.values)
      .find((value) => value.label === "Red");

    expect(red?.selected).toBe(true);
  });

  /** Counting a facet against its own group would read zero for every unticked value. */
  it("counts a facet's values against the other filters, not its own", async () => {
    await seedProduct({
      title: "Red",
      priceBdt: 100_00,
      values: [colourValues.Red],
    });
    await seedProduct({
      title: "Blue",
      priceBdt: 100_00,
      values: [colourValues.Blue],
    });

    const facets = await listFacets({ valueIds: [colourValues.Red] });
    const blue = facets.attributes
      .flatMap((attribute) => attribute.values)
      .find((value) => value.label === "Blue");

    // Blue still shows what ticking it would add, rather than 0.
    expect(blue?.count).toBe(1);
  });

  it("reports the real price span of the results", async () => {
    await seedProduct({ title: "Cheap", priceBdt: 100_00 });
    await seedProduct({ title: "Dear", priceBdt: 900_00 });

    const facets = await listFacets({});
    expect(facets.priceRange).toEqual({ minBdt: 100_00, maxBdt: 900_00 });
  });

  it("counts brands from real rows", async () => {
    await seedProduct({ title: "One", brand: "Acme", priceBdt: 100_00 });
    await seedProduct({ title: "Two", brand: "Acme", priceBdt: 100_00 });
    await seedProduct({ title: "Three", brand: "Other", priceBdt: 100_00 });

    const facets = await listFacets({});
    const acme = facets.brands.find((brand) => brand.id === "Acme");

    expect(acme?.count).toBe(2);
  });
});

describe("reading filters from a URL", () => {
  it("keeps only well-formed attribute ids", () => {
    const filters = parseFilterParams({
      value: ["not-a-uuid", "11111111-1111-4111-8111-111111111111"],
    });

    expect(filters.valueIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("converts taka in the URL to paisa in the query", () => {
    expect(parseFilterParams({ min: "500", max: "1500" })).toMatchObject({
      minPriceBdt: 50_000,
      maxPriceBdt: 150_000,
    });
  });

  it("ignores a reversed range rather than returning nothing", () => {
    const filters = parseFilterParams({ min: "900", max: "100" });

    expect(filters.minPriceBdt).toBe(90_000);
    expect(filters.maxPriceBdt).toBeUndefined();
  });

  it("ignores nonsense in the price fields", () => {
    expect(parseFilterParams({ min: "abc", max: "-5" })).toMatchObject({
      minPriceBdt: undefined,
      maxPriceBdt: undefined,
    });
  });

  it("accepts the old preorder=1 link", () => {
    expect(parseFilterParams({ preorder: "1" }).fulfillment).toBe("preorder");
  });

  it("knows when nothing is filtering", () => {
    expect(hasActiveFilters(parseFilterParams({}))).toBe(false);
    expect(hasActiveFilters(parseFilterParams({ brand: "Acme" }))).toBe(true);
  });
});

describe("autosuggest", () => {
  it("says nothing for one character", async () => {
    await seedProduct({ title: "Studio headphones", priceBdt: 100_00 });
    expect(await suggestSearch("s")).toHaveLength(0);
  });

  it("suggests a product by title", async () => {
    await seedProduct({ title: "Studio headphones", priceBdt: 100_00 });

    const suggestions = await suggestSearch("stud");
    expect(suggestions[0]).toMatchObject({
      kind: "product",
      label: "Studio headphones",
      href: "/products/studio-headphones",
    });
  });

  it("ranks a prefix match above a match inside the title", async () => {
    await seedProduct({ title: "Reference studio monitor", priceBdt: 100_00 });
    await seedProduct({ title: "Studio headphones", priceBdt: 100_00 });

    const suggestions = await suggestSearch("studio");
    expect(suggestions[0].label).toBe("Studio headphones");
  });

  it("suggests brands and categories too", async () => {
    await seedProduct({ title: "Anything", brand: "Snackco", priceBdt: 100_00 });

    const suggestions = await suggestSearch("snack");
    const kinds = suggestions.map((suggestion) => suggestion.kind);

    expect(kinds).toContain("brand");
    expect(kinds).toContain("category");
  });

  /** A draft is not public, so it cannot be suggested either. */
  it("never suggests a draft product", async () => {
    await createProduct(staff, {
      title: "Secret drop",
      categoryId,
      status: "draft",
    });

    expect(await suggestSearch("secret")).toHaveLength(0);
  });
});
