/**
 * Cache invalidation from catalogue mutations (lib/cache.ts, D-054).
 *
 * Shared storefront data — listings, product pages, the menu — is cached and
 * dropped by tag when staff change the catalogue. The tag is expired from the
 * audit entry, after the transaction commits. Every staff change that a
 * shopper can see must reach it; a missing one leaves the storefront showing
 * the old listing until the entry expires on its own. Shopper activity (carts)
 * must not, or the cache would be emptied by every add-to-cart.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const expired = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  revalidateTag: (tag: string) => {
    expired.push(tag);
  },
}));

import { productImages, productVariants, users } from "@/db/schema";
import { updateSetting } from "@/lib/admin/settings";
import type { SessionUser } from "@/lib/auth/session";
import { CACHE_TAGS, invalidateForAudit } from "@/lib/cache";
import { addToCart, getOrCreateCart } from "@/lib/cart";
import {
  addAttributeValue,
  createCategory,
  createProduct,
  createProductOption,
  listProductOptions,
  removeProductOptionValue,
  reorderProductImage,
  setProductAttributes,
  unpublishProduct,
  updateCategory,
  updateProduct,
  updateProductImageAltText,
  updateVariant,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const owner: SessionUser = { id: "", email: "owner@example.com", role: "super_admin" };
let categoryId = "";
let productId = "";
let variantId = "";
let imageIds: string[] = [];

const catalogue = [CACHE_TAGS.listing, CACHE_TAGS.productPages];

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db
    .insert(users)
    .values({ email: owner.email, passwordHash: "x", role: "super_admin" })
    .returning({ id: users.id });
  owner.id = row.id;

  const category = await createCategory(owner, { name: "Snacks", slug: "snacks" });
  categoryId = category.id;
  const product = await createProduct(owner, { title: "Candy box", categoryId, status: "preorder_open" });
  productId = product.id;
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId, sku: "CANDY-1", priceBdt: 500_00, fulfillmentMode: "preorder", preorderCapacity: 10 })
    .returning({ id: productVariants.id });
  variantId = variant.id;
  imageIds = (
    await harness.db
      .insert(productImages)
      .values([
        { productId, url: "/uploads/a.webp", altText: "Front", sortOrder: 0 },
        { productId, url: "/uploads/b.webp", altText: "Back", sortOrder: 1 },
      ])
      .returning({ id: productImages.id })
  ).map((image) => image.id);

  expired.length = 0;
});

describe("staff changes a shopper can see", () => {
  const cases: [string, () => Promise<unknown>, string[]][] = [
    ["editing a product", () => updateProduct(owner, productId, { brand: "Hometown" }), catalogue],
    ["changing a price", () => updateVariant(owner, variantId, { priceBdt: 450_00 }), catalogue],
    ["unpublishing", () => unpublishProduct(owner, productId), catalogue],
    ["renaming a category", () => updateCategory(owner, categoryId, { name: "Sweets", slug: "snacks" }), [CACHE_TAGS.categories, ...catalogue]],
    ["describing a photograph", () => updateProductImageAltText(owner, imageIds[1], "The back of the box"), catalogue],
    ["moving a photograph", () => reorderProductImage(owner, imageIds[1], "up"), catalogue],
    ["adding an option", () => createProductOption(owner, productId, { name: "Flavour", values: ["Mint"] }), catalogue],
    ["linking options", () => setProductAttributes(owner, productId, []), catalogue],
    ["changing a displayed setting", () => updateSetting(owner, "landed.duty_percent", 30), [CACHE_TAGS.productPages]],
  ];

  for (const [name, change, tags] of cases) {
    it(`${name} expires the cached copies`, async () => {
      await change();
      expect(expired).toEqual(expect.arrayContaining(tags));
    });
  }

  it("adding and removing an option value expires the cached copies each time", async () => {
    const option = await createProductOption(owner, productId, { name: "Size", values: ["Small"] });
    expired.length = 0;
    const value = await addAttributeValue(owner, option.id, "Large");
    expect(expired).toEqual(expect.arrayContaining(catalogue));

    expired.length = 0;
    await removeProductOptionValue(owner, value.id);
    expect(expired).toEqual(expect.arrayContaining(catalogue));
    const [after] = await listProductOptions(productId);
    expect(after.values.map((entry) => entry.value)).toEqual(["Small"]);
  });
});

describe("what does not expire the catalogue", () => {
  it("a shopper adding to their cart", async () => {
    const cartId = await getOrCreateCart({ userId: null, sessionToken: "shopper-token" });
    await addToCart(cartId, variantId, 1);
    expect(expired).toEqual([]);
  });

  it("order and account audit entries", () => {
    invalidateForAudit("order");
    invalidateForAudit("user");
    expect(expired).toEqual([]);
  });
});
