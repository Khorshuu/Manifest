/**
 * Product-owned variant options (D-040): a new product starts with none,
 * options and values belong to one product, removing a value touches only
 * that product, a variant can carry its own photo — and SEO Pulse's one-click
 * fill writes only into empty fields.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productImages, productVariants, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  createProductOption,
  deleteProduct,
  duplicateProduct,
  generateVariants,
  listProductOptions,
  listVariants,
  removeProductOption,
  removeProductOptionValue,
  setVariantImage,
} from "@/lib/catalog";
import { fillWithSeoPulse } from "@/lib/seo-pulse";
import { setSeoDataProviderForTesting } from "@/lib/seo-pulse/providers/data";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "customer@example.com", role: "customer" };
let sofaA = "";
let sofaB = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setSeoDataProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setSeoDataProviderForTesting(null);
  const rows = await harness.db
    .insert(users)
    .values([
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === staff.email)!.id;
  customer.id = rows.find((row) => row.email === customer.email)!.id;

  const category = await createCategory(staff, { name: "Sofas", slug: "sofas" });
  sofaA = (await createProduct(staff, { title: "Sofa A", categoryId: category.id })).id;
  sofaB = (await createProduct(staff, { title: "Sofa B", categoryId: category.id })).id;
});

async function colourOn(productId: string, values: string[]) {
  const option = await createProductOption(staff, productId, { name: "Color", values });
  await generateVariants(staff, productId, { priceBdt: 5_000_000 });
  return option;
}

describe("options belong to one product", () => {
  it("starts a new product with no options, whatever other products have", async () => {
    await colourOn(sofaA, ["White", "Grey", "Beige"]);
    expect(await listProductOptions(sofaB)).toEqual([]);
    expect(await listVariants(staff, sofaB)).toEqual([]);
  });

  it("lets two products each have their own Color with different values", async () => {
    await colourOn(sofaA, ["White", "Grey"]);
    await colourOn(sofaB, ["Navy", "Grey"]);
    const [a] = await listProductOptions(sofaA);
    const [b] = await listProductOptions(sofaB);
    expect(a.id).not.toBe(b.id);
    expect(a.values.map((value) => value.value)).toEqual(["White", "Grey"]);
    expect(b.values.map((value) => value.value)).toEqual(["Navy", "Grey"]);
  });

  it("refuses a second option with the same name on one product", async () => {
    await colourOn(sofaA, ["White"]);
    await expect(createProductOption(staff, sofaA, { name: "color", values: [] })).rejects.toMatchObject({ status: 409 });
  });

  it("removes a value and its variant from one product only", async () => {
    const option = await colourOn(sofaA, ["White", "Grey"]);
    await colourOn(sofaB, ["White", "Grey"]);
    const white = (await listProductOptions(sofaA))[0].values.find((value) => value.value === "White")!;

    const result = await removeProductOptionValue(staff, white.id);
    expect(result).toEqual({ deleted: 1, archived: 0 });

    expect((await listProductOptions(sofaA))[0].values.map((value) => value.value)).toEqual(["Grey"]);
    expect((await listVariants(staff, sofaA)).map((variant) => variant.label)).toEqual(["Grey"]);
    // Sofa B is untouched.
    expect((await listVariants(staff, sofaB)).map((variant) => variant.label).sort()).toEqual(["Grey", "White"]);
    expect(option.id).toBeTruthy();
  });

  it("removes a whole group from one product, leaving it able to sell one variant", async () => {
    const option = await colourOn(sofaA, ["White", "Grey"]);
    await removeProductOption(staff, sofaA, option.id);
    await generateVariants(staff, sofaA, { priceBdt: 5_000_000 });
    expect(await listProductOptions(sofaA)).toEqual([]);
    const variants = (await listVariants(staff, sofaA)).filter((variant) => variant.archivedAt === null);
    expect(variants.map((variant) => variant.label)).toEqual(["Single variant"]);
  });

  it("prunes variants that no longer fit when a group is added", async () => {
    // A plain variant first, as a product with no groups has.
    await generateVariants(staff, sofaA, { priceBdt: 5_000_000 });
    expect((await listVariants(staff, sofaA)).map((variant) => variant.label)).toEqual(["Single variant"]);

    const colour = await createProductOption(staff, sofaA, { name: "Color", values: ["White", "Grey"] });
    const first = await generateVariants(staff, sofaA, { priceBdt: 5_000_000, prune: true });
    expect(first).toMatchObject({ created: 2, removed: 1 });

    const size = await createProductOption(staff, sofaA, { name: "Size", values: ["2-Seater", "3-Seater"] });
    const second = await generateVariants(staff, sofaA, { priceBdt: 5_000_000, prune: true });
    expect(second).toMatchObject({ created: 4, removed: 2 });

    const live = (await listVariants(staff, sofaA)).filter((variant) => variant.archivedAt === null);
    expect(live).toHaveLength(4);
    expect(colour.id).not.toBe(size.id);
  });

  it("will not remove another product's option", async () => {
    const option = await colourOn(sofaA, ["White"]);
    await expect(removeProductOption(staff, sofaB, option.id)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a customer", async () => {
    await expect(createProductOption(customer, sofaA, { name: "Size", values: ["S"] })).rejects.toThrow(AuthorizationError);
  });
});

describe("deleting and duplicating a product with its own options", () => {
  it("deletes a product together with the options it owns", async () => {
    await colourOn(sofaA, ["White", "Grey"]);
    await deleteProduct(staff, sofaA);
    expect(await listProductOptions(sofaA)).toEqual([]);
  });

  it("gives a duplicate its own copies of the options, so editing one leaves the other alone", async () => {
    await colourOn(sofaA, ["White", "Grey"]);
    const copy = await duplicateProduct(staff, sofaA);
    const [original] = await listProductOptions(sofaA);
    const [copied] = await listProductOptions(copy.id);
    expect(copied.id).not.toBe(original.id);
    expect(copied.values.map((value) => value.value)).toEqual(["White", "Grey"]);
    expect((await listVariants(staff, copy.id)).map((variant) => variant.label).sort()).toEqual(["Grey", "White"]);

    const white = copied.values.find((value) => value.value === "White")!;
    await removeProductOptionValue(staff, white.id);
    expect((await listVariants(staff, sofaA)).map((variant) => variant.label).sort()).toEqual(["Grey", "White"]);
  });
});

describe("variant photos", () => {
  it("links one of the product's photographs to a variant, and refuses another product's", async () => {
    await colourOn(sofaA, ["White"]);
    const [variant] = await listVariants(staff, sofaA);
    const [mine] = await harness.db
      .insert(productImages)
      .values({ productId: sofaA, url: "/white-sofa.jpg", altText: "White sofa", sortOrder: 0 })
      .returning();
    const [theirs] = await harness.db
      .insert(productImages)
      .values({ productId: sofaB, url: "/other.jpg", altText: "Other", sortOrder: 0 })
      .returning();

    await setVariantImage(staff, variant.id, mine.id);
    const [withPhoto] = await listVariants(staff, sofaA);
    expect(withPhoto.imageUrl).toBe("/white-sofa.jpg");
    expect(withPhoto.imageId).toBe(mine.id);

    await expect(setVariantImage(staff, variant.id, theirs.id)).rejects.toThrow(/does not belong/);

    await setVariantImage(staff, variant.id, null);
    expect((await listVariants(staff, sofaA))[0].imageUrl).toBeNull();
  });
});

describe("SEO Pulse one-click fill", () => {
  it("fills empty fields, keeps the admin's own text, and lists facts it cannot know", async () => {
    await harness.db
      .update(products)
      .set({ brand: "Northfield", seoMetaTitle: "My own title" })
      .where(eq(products.id, sofaA));
    await colourOn(sofaA, ["White"]);

    const result = await fillWithSeoPulse(staff, sofaA);
    expect(result.filled).toEqual(expect.arrayContaining(["Focus keyword", "Meta description", "Description"]));
    expect(result.kept).toContain("SEO title");
    expect(result.needsInput).toEqual(expect.arrayContaining(["Dimensions", "Weight", "Material"]));

    const [row] = await harness.db.select().from(products).where(eq(products.id, sofaA));
    expect(row.seoMetaTitle).toBe("My own title");
    expect(row.seoFocusKeyword).toBeTruthy();
    // The starter description states only the shop's own facts.
    expect(row.descriptionHtml).toContain("Sourced from the United States");
    expect(row.descriptionHtml).not.toMatch(/cm|kg|leather|warranty/i);
    const variants = await harness.db.select().from(productVariants).where(eq(productVariants.productId, sofaA));
    expect(variants).toHaveLength(1);
  });

  it("refuses a customer", async () => {
    await expect(fillWithSeoPulse(customer, sofaA)).rejects.toThrow(AuthorizationError);
  });
});
