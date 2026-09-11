/**
 * Search across everything a listing says about itself.
 *
 * The behaviour these protect is the one the redesign was asked for: a shopper
 * who types a word from a description, a tag, a category or an option value
 * finds the product, without knowing its name. The previous implementation
 * matched the title and the brand only, and every one of these cases returned
 * nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  attributeValues,
  attributes,
  productVariants,
  users,
  variantOptionValues,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  listProductCards,
  suggestSearch,
  toTsQuery,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

let electronicsId = "";
let snacksId = "";

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

  electronicsId = (
    await createCategory(staff, { name: "Electronics", slug: "electronics" })
  ).id;
  snacksId = (await createCategory(staff, { name: "Snacks", slug: "snacks" })).id;
});

async function seed(options: {
  title: string;
  categoryId?: string;
  brand?: string;
  descriptionHtml?: string;
  bulletFeatures?: string[];
  tags?: string[];
  priceBdt?: number;
}) {
  const product = await createProduct(staff, {
    title: options.title,
    categoryId: options.categoryId ?? electronicsId,
    brand: options.brand,
    descriptionHtml: options.descriptionHtml,
    bulletFeatures: options.bulletFeatures,
    tags: options.tags,
    status: "preorder_open",
  });

  await harness.db.insert(productVariants).values({
    productId: product.id,
    sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
    priceBdt: options.priceBdt ?? 5_000_00,
    fulfillmentMode: "preorder",
    preorderClosesAt: new Date(Date.now() + 86_400_000),
  });

  return product;
}

const titles = async (query: string) =>
  (await listProductCards({ query, limit: 20 })).map((card) => card.title);

describe("what a search matches", () => {
  it("finds a product by a word in its description", async () => {
    await seed({
      title: "Mechanical Keyboard",
      descriptionHtml: "<p>A compact board with tactile switches.</p>",
    });
    await seed({ title: "Desk Lamp", descriptionHtml: "<p>Warm light.</p>" });

    expect(await titles("tactile")).toEqual(["Mechanical Keyboard"]);
  });

  it("finds a product by one of its bullet points", async () => {
    await seed({
      title: "Travel Mug",
      bulletFeatures: ["Keeps coffee hot for eight hours"],
    });

    expect(await titles("hot")).toEqual(["Travel Mug"]);
  });

  it("finds a product by a tag", async () => {
    await seed({ title: "Gift Box", tags: ["seasonal", "limited"] });

    expect(await titles("seasonal")).toEqual(["Gift Box"]);
  });

  it("finds a product by the name of the category it is filed in", async () => {
    await seed({ title: "Sour Cherry Tin", categoryId: snacksId });
    await seed({ title: "Desk Lamp", categoryId: electronicsId });

    expect(await titles("snacks")).toEqual(["Sour Cherry Tin"]);
  });

  it("finds a product by one of its option values", async () => {
    const product = await seed({ title: "Field Jacket" });

    const [colour] = await harness.db
      .insert(attributes)
      .values({ name: "Colour" })
      .returning({ id: attributes.id });
    const [sandstone] = await harness.db
      .insert(attributeValues)
      .values({ attributeId: colour.id, value: "Sandstone", sortOrder: 0 })
      .returning({ id: attributeValues.id });

    const [variant] = await harness.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));

    await harness.db.insert(variantOptionValues).values({
      variantId: variant.id,
      attributeId: colour.id,
      attributeValueId: sandstone.id,
    });

    expect(await titles("sandstone")).toEqual(["Field Jacket"]);
  });

  it("matches a prefix, so it works while someone is still typing", async () => {
    await seed({ title: "Mechanical Keyboard" });

    expect(await titles("keyboa")).toEqual(["Mechanical Keyboard"]);
  });

  it("matches inside a word, which a stemmed prefix cannot", async () => {
    await seed({ title: "Mechanical Keyboard" });

    expect(await titles("board")).toEqual(["Mechanical Keyboard"]);
  });

  it("narrows rather than widens when a second word is typed", async () => {
    await seed({
      title: "Mechanical Keyboard",
      descriptionHtml: "<p>Tactile switches for typing.</p>",
    });
    await seed({ title: "Tactile Mouse Pad" });

    expect(await titles("tactile keyboard")).toEqual(["Mechanical Keyboard"]);
  });

  it("does not search the description's markup", async () => {
    await seed({
      title: "Desk Lamp",
      descriptionHtml: "<p class='blockquote'>Warm light.</p>",
    });

    // "blockquote" appears only inside a tag, so it is not vocabulary.
    expect(await titles("blockquote")).toEqual([]);
  });

  it("never returns a draft", async () => {
    await createProduct(staff, {
      title: "Secret drop",
      categoryId: electronicsId,
      descriptionHtml: "<p>Tactile switches.</p>",
      status: "draft",
    });

    expect(await titles("tactile")).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts a title match above a mention in a description", async () => {
    await seed({
      title: "Desk Lamp",
      descriptionHtml: "<p>Sits beside your keyboard.</p>",
    });
    await seed({ title: "Keyboard, Mechanical" });

    expect((await titles("keyboard"))[0]).toBe("Keyboard, Mechanical");
  });
});

describe("the tsquery builder", () => {
  it("makes every word a prefix and requires all of them", () => {
    expect(toTsQuery("tactile keyboard")).toBe("tactile:* & keyboard:*");
  });

  it("strips anything tsquery would treat as an operator", () => {
    // Without this a search box is a way to send expressions to the parser.
    expect(toTsQuery("cat & dog | !bird")).toBe("cat:* & dog:* & bird:*");
  });

  it("returns null when nothing usable was typed", () => {
    expect(toTsQuery("???")).toBeNull();
    expect(toTsQuery("   ")).toBeNull();
  });
});

describe("autosuggest", () => {
  it("suggests a product found through its description", async () => {
    await seed({
      title: "Mechanical Keyboard",
      descriptionHtml: "<p>Tactile switches.</p>",
    });

    const suggestions = await suggestSearch("tactil");
    expect(suggestions[0]).toMatchObject({
      kind: "product",
      label: "Mechanical Keyboard",
    });
  });

  it("offers a tag as a search worth running", async () => {
    await seed({ title: "Gift Box", tags: ["seasonal"] });

    const searches = (await suggestSearch("season")).filter(
      (suggestion) => suggestion.kind === "search",
    );
    expect(searches.map((suggestion) => suggestion.label)).toContain("seasonal");
  });

  /*
   * This used to assert no price at all. The search brief asks for the price
   * beside a suggested product, and it is the same figure every card on the
   * site shows publicly — so the rule is now: the shopper's price, nothing
   * behind it (DECISIONS.md D-028).
   */
  it("carries only the price a shopper would see", async () => {
    await seed({ title: "Mechanical Keyboard", priceBdt: 12_345_00 });

    const product = (await suggestSearch("mech")).find(
      (suggestion) => suggestion.kind === "product",
    );
    expect(product?.priceBdt).toBe(12_345_00);
    expect(JSON.stringify(product)).not.toMatch(/cost/i);
  });
});
