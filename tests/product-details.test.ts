/**
 * The listing fields added for the product-detail work: partial saves, unique
 * SKUs, category-defined specifications, sale pricing, and the separation of
 * gallery photography from lifestyle imagery.
 *
 * These call the lib/ functions directly rather than going through a route,
 * for the same reason the rest of the catalogue tests do: the rules have to
 * hold on every code path, not only on the one the admin screen happens to
 * use.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productVariants, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  CategoryAttributeError,
  createCategory,
  createCategoryAttribute,
  createProduct,
  deleteCategoryAttribute,
  DuplicateSkuError,
  discountPercent,
  effectivePrice,
  formatAttributeValue,
  getProductForAdmin,
  getPublicProductBySlug,
  isSaleLive,
  listCategoryAttributes,
  resolveCategoryAttributes,
  stockState,
  updateProduct,
  validateAttributeValues,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "customer@example.com",
  role: "customer",
};

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
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "customer@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, role: users.role });

  staff.id = rows.find((row) => row.role === "staff_admin")!.id;
  customer.id = rows.find((row) => row.role === "customer")!.id;
});

async function seedProduct(title = "Studio headphones") {
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  const product = await createProduct(staff, { title, categoryId: category.id });
  return { category, product };
}

describe("partial product saves", () => {
  it("leaves fields the caller did not send alone", async () => {
    const { product } = await seedProduct();

    await updateProduct(staff, product.id, { brand: "Northfield" });
    await updateProduct(staff, product.id, {
      seoMetaDescription: "Open-back headphones, imported to order.",
    });

    const saved = await getProductForAdmin(staff, product.id);

    // The second save owned only the SEO field, and did not erase the first.
    expect(saved?.brand).toBe("Northfield");
    expect(saved?.seoMetaDescription).toBe(
      "Open-back headphones, imported to order.",
    );
  });

  it("clears a field only when null is sent for it", async () => {
    const { product } = await seedProduct();

    await updateProduct(staff, product.id, { brand: "Northfield" });
    await updateProduct(staff, product.id, { brand: null });

    expect((await getProductForAdmin(staff, product.id))?.brand).toBeNull();
  });

  it("keeps the slug when the title is unchanged", async () => {
    const { product } = await seedProduct();
    await updateProduct(staff, product.id, { brand: "Northfield" });

    expect((await getProductForAdmin(staff, product.id))?.slug).toBe(
      product.slug,
    );
  });

  it("refuses a customer", async () => {
    const { product } = await seedProduct();

    await expect(
      updateProduct(customer, product.id, { brand: "Sneaky" }),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("product SKUs", () => {
  it("refuses a SKU another product already carries", async () => {
    const { category } = await seedProduct();
    await createProduct(staff, {
      title: "First",
      categoryId: category.id,
      sku: "HP-001",
    });

    await expect(
      createProduct(staff, {
        title: "Second",
        categoryId: category.id,
        sku: "HP-001",
      }),
    ).rejects.toThrow(DuplicateSkuError);
  });

  it("lets a product keep its own SKU on a later save", async () => {
    const { category } = await seedProduct();
    const created = await createProduct(staff, {
      title: "First",
      categoryId: category.id,
      sku: "HP-001",
    });

    await expect(
      updateProduct(staff, created.id, { sku: "HP-001", brand: "Northfield" }),
    ).resolves.toBeDefined();
  });

  it("allows any number of products with no SKU at all", async () => {
    const { category } = await seedProduct();

    await createProduct(staff, { title: "A", categoryId: category.id });
    await expect(
      createProduct(staff, { title: "B", categoryId: category.id }),
    ).resolves.toBeDefined();
  });
});

describe("category specifications", () => {
  it("asks a child category for what its parent defines", async () => {
    const parent = await createCategory(staff, {
      name: "Electronics",
      slug: "electronics",
    });
    const child = await createCategory(staff, {
      name: "Monitors",
      slug: "monitors",
      parentId: parent.id,
    });

    await createCategoryAttribute(staff, parent.id, {
      name: "Brand tier",
      dataType: "text",
    });
    await createCategoryAttribute(staff, child.id, {
      name: "Refresh rate",
      dataType: "number",
      unit: "Hz",
    });

    const resolved = await resolveCategoryAttributes(child.id);

    expect(resolved.map((entry) => entry.name)).toEqual([
      "Brand tier",
      "Refresh rate",
    ]);
    // Only its own is editable from the child.
    expect((await listCategoryAttributes(child.id)).map((e) => e.name)).toEqual([
      "Refresh rate",
    ]);
  });

  it("refuses a customer defining one", async () => {
    const { category } = await seedProduct();

    await expect(
      createCategoryAttribute(customer, category.id, {
        name: "Sneaky",
        dataType: "text",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a choice attribute with no choices", async () => {
    const { category } = await seedProduct();

    await expect(
      createCategoryAttribute(staff, category.id, {
        name: "Fit",
        dataType: "select",
        options: [],
      }),
    ).rejects.toThrow(CategoryAttributeError);
  });

  it("stores a value the category asks for, and refuses one it does not", async () => {
    const { category, product } = await seedProduct();
    const attribute = await createCategoryAttribute(staff, category.id, {
      name: "Driver size",
      dataType: "number",
      unit: "mm",
    });

    await updateProduct(staff, product.id, {
      attributeValues: { [attribute.id]: "50" },
    });

    const saved = await getProductForAdmin(staff, product.id);
    expect(saved?.attributeValues).toEqual({ [attribute.id]: "50" });

    await expect(
      updateProduct(staff, product.id, {
        attributeValues: { "00000000-0000-0000-0000-000000000001": "x" },
      }),
    ).rejects.toThrow(CategoryAttributeError);
  });

  it("refuses a choice that is not on the list", async () => {
    const { category } = await seedProduct();
    const attribute = await createCategoryAttribute(staff, category.id, {
      name: "Fit",
      dataType: "select",
      options: ["Slim", "Regular"],
    });

    const definitions = await resolveCategoryAttributes(category.id);

    expect(() =>
      validateAttributeValues(definitions, { [attribute.id]: "Baggy" }),
    ).toThrow(CategoryAttributeError);
    expect(
      validateAttributeValues(definitions, { [attribute.id]: "Slim" }),
    ).toEqual({ [attribute.id]: "Slim" });
  });

  it("drops blank values rather than storing an empty row", async () => {
    const { category } = await seedProduct();
    const attribute = await createCategoryAttribute(staff, category.id, {
      name: "Notes",
      dataType: "text",
    });

    const definitions = await resolveCategoryAttributes(category.id);
    expect(validateAttributeValues(definitions, { [attribute.id]: "  " })).toEqual(
      {},
    );
  });

  it("insists on a required one", async () => {
    const { category } = await seedProduct();
    await createCategoryAttribute(staff, category.id, {
      name: "Voltage",
      dataType: "text",
      isRequired: true,
    });

    const definitions = await resolveCategoryAttributes(category.id);
    expect(() => validateAttributeValues(definitions, {})).toThrow(
      CategoryAttributeError,
    );
  });

  it("takes stored values away with the definition", async () => {
    const { category, product } = await seedProduct();
    const attribute = await createCategoryAttribute(staff, category.id, {
      name: "Driver size",
      dataType: "text",
    });

    await updateProduct(staff, product.id, {
      attributeValues: { [attribute.id]: "50mm" },
    });
    await deleteCategoryAttribute(staff, attribute.id);

    const saved = await getProductForAdmin(staff, product.id);
    expect(saved?.attributeValues).toEqual({});
  });

  it("formats a value the way the product page shows it", () => {
    const base = {
      id: "a",
      categoryId: "c",
      categoryName: "Audio",
      isRequired: false,
      isFilterable: true,
      isSearchable: true,
      sortOrder: 0,
      options: [] as string[],
    };

    expect(
      formatAttributeValue(
        { ...base, name: "Driver", dataType: "number", unit: "mm" },
        "50",
      ),
    ).toBe("50 mm");
    expect(
      formatAttributeValue(
        { ...base, name: "Wireless", dataType: "boolean", unit: null },
        "true",
      ),
    ).toBe("Yes");
    expect(
      formatAttributeValue(
        { ...base, name: "Colours", dataType: "multiselect", unit: null },
        ["Black", "Sand"],
      ),
    ).toBe("Black, Sand");
  });
});

describe("sale pricing", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const base = { priceBdt: 10_000, saleStartsAt: null, saleEndsAt: null };

  it("charges the sale price inside the window", () => {
    expect(effectivePrice({ ...base, salePriceBdt: 8_000 }, now)).toBe(8_000);
    expect(discountPercent({ ...base, salePriceBdt: 8_000 }, now)).toBe(20);
  });

  it("charges the regular price before the sale starts", () => {
    const variant = {
      ...base,
      salePriceBdt: 8_000,
      saleStartsAt: new Date("2026-07-01T00:00:00Z"),
    };

    expect(isSaleLive(variant, now)).toBe(false);
    expect(effectivePrice(variant, now)).toBe(10_000);
  });

  it("charges the regular price once the sale has ended", () => {
    const variant = {
      ...base,
      salePriceBdt: 8_000,
      saleEndsAt: new Date("2026-06-01T00:00:00Z"),
    };

    expect(effectivePrice(variant, now)).toBe(10_000);
    expect(discountPercent(variant, now)).toBeNull();
  });

  it("ignores a sale price that is not a saving", () => {
    expect(effectivePrice({ ...base, salePriceBdt: 10_000 }, now)).toBe(10_000);
  });

  it("is the price the public query returns", async () => {
    const { category } = await seedProduct();
    const [row] = await harness.db
      .insert(products)
      .values({
        title: "On offer",
        slug: "on-offer",
        categoryId: category.id,
        status: "in_stock",
      })
      .returning({ id: products.id });

    await harness.db.insert(productVariants).values({
      productId: row.id,
      sku: "OFFER-1",
      priceBdt: 10_000,
      salePriceBdt: 7_500,
      fulfillmentMode: "in_stock",
      stockQuantity: 4,
      lowStockThreshold: 5,
    });

    const { getPublicVariants } = await import("@/lib/catalog");
    const [variant] = await getPublicVariants(row.id);

    expect(variant.priceBdt).toBe(7_500);
    expect(variant.listPriceBdt).toBe(10_000);
  });

  it("refuses a sale price above the regular price", async () => {
    const { category } = await seedProduct();
    const [row] = await harness.db
      .insert(products)
      .values({ title: "Bad sale", slug: "bad-sale", categoryId: category.id })
      .returning({ id: products.id });

    await harness.db.insert(productVariants).values({
      productId: row.id,
      sku: "BAD-1",
      priceBdt: 5_000,
    });

    const { updateVariant, VariantPricingError } = await import("@/lib/catalog");
    const [variant] = await harness.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, row.id));

    await expect(
      updateVariant(staff, variant.id, { salePriceBdt: 6_000 }),
    ).rejects.toThrow(VariantPricingError);
  });
});

describe("stock states", () => {
  const preorder = {
    fulfillmentMode: "preorder",
    stockQuantity: null,
    lowStockThreshold: null,
    preorderCapacity: 10,
    preorderReserved: 0,
  };

  it("names each in-stock state once", () => {
    const base = {
      fulfillmentMode: "in_stock",
      preorderCapacity: null,
      preorderReserved: 0,
    };

    expect(
      stockState({ ...base, stockQuantity: 20, lowStockThreshold: 5 }),
    ).toBe("in_stock");
    expect(stockState({ ...base, stockQuantity: 4, lowStockThreshold: 5 })).toBe(
      "low_stock",
    );
    expect(stockState({ ...base, stockQuantity: 0, lowStockThreshold: 5 })).toBe(
      "out_of_stock",
    );
    // No quantity recorded means unlimited, not empty.
    expect(
      stockState({ ...base, stockQuantity: null, lowStockThreshold: null }),
    ).toBe("in_stock");
  });

  it("names a full and a closed preorder apart", () => {
    expect(stockState(preorder)).toBe("preorder");
    expect(stockState({ ...preorder, preorderReserved: 10 })).toBe(
      "preorder_full",
    );
    expect(stockState({ ...preorder, isClosed: true })).toBe("closed");
  });
});

describe("gallery and lifestyle imagery", () => {
  it("keeps the two apart on both the admin and the public read", async () => {
    const { product } = await seedProduct();
    const { addProductImage } = await import("@/lib/catalog");

    // A 1x1 PNG, so the upload passes the byte-level format check.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    await addProductImage(staff, product.id, {
      data: png,
      originalName: "a.png",
      contentType: "image/png",
      altText: "The headphones, three-quarter view",
    });
    await addProductImage(staff, product.id, {
      data: png,
      originalName: "b.png",
      contentType: "image/png",
      altText: "The headphones on a desk",
      kind: "lifestyle",
    });

    const admin = await getProductForAdmin(staff, product.id);
    expect(admin?.images).toHaveLength(1);
    expect(admin?.lifestyleImages).toHaveLength(1);

    await updateProduct(staff, product.id, { status: "in_stock" });
    const shopper = await getPublicProductBySlug(product.slug);

    expect(shopper?.images).toHaveLength(1);
    expect(shopper?.lifestyleImages[0].altText).toBe(
      "The headphones on a desk",
    );
  });
});
