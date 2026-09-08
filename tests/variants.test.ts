/**
 * The variation engine against a real (in-process) Postgres.
 *
 * The rules asserted here are the ones with money behind them: regenerating
 * must never disturb a variant that already carries capacity or orders, and
 * capacity can never be lowered under slots that are already reserved.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attributeValues,
  auditLog,
  productVariants,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  bulkUpdateVariants,
  CapacityBelowReservedError,
  countVariants,
  createAttribute,
  createCategory,
  createProduct,
  generateVariants,
  getProductAxes,
  listPurchasableVariants,
  listVariants,
  remainingCapacity,
  setProductAttributes,
  setVariantEnabled,
  updateVariant,
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

  staff.id = rows.find((r) => r.role === "staff_admin")!.id;
  customer.id = rows.find((r) => r.role === "customer")!.id;
});

/** A product varying by Color (Red, Blue) and Size (Small, Large). */
async function seedProductWithAxes() {
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  const product = await createProduct(staff, {
    title: "Studio Headphones",
    categoryId: category.id,
  });

  const color = await createAttribute(staff, {
    name: "Color",
    inputType: "select",
    values: ["Red", "Blue"],
  });
  const size = await createAttribute(staff, {
    name: "Size",
    inputType: "select",
    values: ["Small", "Large"],
  });

  await setProductAttributes(staff, product.id, [color.id, size.id]);

  return { product, color, size };
}

describe("getProductAxes", () => {
  it("returns each attribute with all of its values", async () => {
    const { product } = await seedProductWithAxes();
    const axes = await getProductAxes(product.id);

    expect(axes).toHaveLength(2);
    expect(axes.map((axis) => axis.name)).toEqual(["Color", "Size"]);
    expect(axes[0].values.map((value) => value.value).sort()).toEqual([
      "Blue",
      "Red",
    ]);
  });

  it("returns nothing for a product with no attributes", async () => {
    const category = await createCategory(staff, {
      name: "Snacks",
      slug: "snacks",
    });
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
    });

    await expect(getProductAxes(product.id)).resolves.toEqual([]);
  });
});

describe("generateVariants", () => {
  it("refuses a customer", async () => {
    const { product } = await seedProductWithAxes();
    await expect(
      generateVariants(customer, product.id, { priceBdt: 100 }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("creates every combination once", async () => {
    const { product } = await seedProductWithAxes();

    const result = await generateVariants(staff, product.id, {
      priceBdt: 315000,
    });

    expect(result.created).toBe(4);
    await expect(countVariants(product.id)).resolves.toBe(4);

    const variants = await listVariants(staff, product.id);
    expect(variants.map((v) => v.label).sort()).toEqual([
      "Blue / Large",
      "Blue / Small",
      "Red / Large",
      "Red / Small",
    ]);
  });

  it("gives each variant a distinct SKU", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 1 });

    const variants = await listVariants(staff, product.id);
    expect(new Set(variants.map((v) => v.sku)).size).toBe(variants.length);
  });

  it("is idempotent: running twice creates nothing the second time", async () => {
    const { product } = await seedProductWithAxes();

    await generateVariants(staff, product.id, { priceBdt: 1 });
    const second = await generateVariants(staff, product.id, { priceBdt: 1 });

    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(4);
    await expect(countVariants(product.id)).resolves.toBe(4);
  });

  /**
   * The important one: a variant that already carries a price and reserved
   * capacity must survive a regeneration untouched.
   */
  it("leaves existing variants and their capacity alone when a value is added", async () => {
    const { product, color } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });

    const [firstVariant] = await listVariants(staff, product.id);
    await updateVariant(staff, firstVariant.id, {
      priceBdt: 999_00,
      preorderCapacity: 10,
    });
    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 4 })
      .where(eq(productVariants.id, firstVariant.id));

    // A third colour appears, so two more combinations become possible.
    const [colorValue] = await harness.db
      .insert(attributeValues)
      .values({ attributeId: color.id, value: "Green", sortOrder: 2 })
      .returning();
    expect(colorValue.value).toBe("Green");

    const result = await generateVariants(staff, product.id, { priceBdt: 100 });

    expect(result.created).toBe(2);
    expect(result.unchanged).toBe(4);

    const [preserved] = await harness.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, firstVariant.id));

    expect(preserved.priceBdt).toBe(999_00);
    expect(preserved.preorderCapacity).toBe(10);
    expect(preserved.preorderReserved).toBe(4);
  });

  /**
   * Dropping an attribute from a product changes what the combinations are.
   * The variants built on the old axes must survive — deleting them would
   * erase what a past order actually bought — and are reported as orphaned.
   */
  it("reports orphaned variants rather than deleting them", async () => {
    const { product, color } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });
    await expect(countVariants(product.id)).resolves.toBe(4);

    // The product now varies by colour alone.
    await setProductAttributes(staff, product.id, [color.id]);

    const result = await generateVariants(staff, product.id, { priceBdt: 100 });

    expect(result.created).toBe(2);
    expect(result.orphaned).toBe(4);
    // Nothing was removed: the four originals are still there.
    await expect(countVariants(product.id)).resolves.toBe(6);
  });

  /**
   * The database refuses to delete an attribute value a variant references,
   * which is the last line of defence behind deleteAttributeValue.
   */
  it("the database refuses to delete a value a variant still uses", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });

    const [blue] = await harness.db
      .select()
      .from(attributeValues)
      .where(eq(attributeValues.value, "Blue"));

    const error = await harness.db
      .delete(attributeValues)
      .where(eq(attributeValues.id, blue.id))
      .then(() => null)
      .catch((thrown) => thrown);

    expect(error).not.toBeNull();
    // Drizzle wraps the driver error; the constraint name is on the cause.
    expect(String(error.cause ?? error)).toMatch(
      /violates foreign key constraint/,
    );
  });

  it("creates nothing for a product with no attributes", async () => {
    const category = await createCategory(staff, {
      name: "Snacks",
      slug: "snacks",
    });
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
    });

    const result = await generateVariants(staff, product.id, { priceBdt: 1 });
    expect(result.created).toBe(0);
  });
});

describe("updateVariant", () => {
  it("refuses a customer", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 1 });
    const [variant] = await listVariants(staff, product.id);

    await expect(
      updateVariant(customer, variant.id, { priceBdt: 1 }),
    ).rejects.toThrow(AuthorizationError);
  });

  /**
   * Lowering capacity under reserved slots would mean more preorders have been
   * taken than can be fulfilled.
   */
  it("refuses capacity below what is already reserved", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 1 });
    const [variant] = await listVariants(staff, product.id);

    await updateVariant(staff, variant.id, { preorderCapacity: 20 });
    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 12 })
      .where(eq(productVariants.id, variant.id));

    await expect(
      updateVariant(staff, variant.id, { preorderCapacity: 5 }),
    ).rejects.toThrow(CapacityBelowReservedError);

    const [unchanged] = await harness.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variant.id));
    expect(unchanged.preorderCapacity).toBe(20);
  });

  it("allows capacity exactly at the reserved count", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 1 });
    const [variant] = await listVariants(staff, product.id);

    await updateVariant(staff, variant.id, { preorderCapacity: 20 });
    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 12 })
      .where(eq(productVariants.id, variant.id));

    const updated = await updateVariant(staff, variant.id, {
      preorderCapacity: 12,
    });
    expect(updated.preorderCapacity).toBe(12);
  });

  it("records a price change as its own audit action", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const [variant] = await listVariants(staff, product.id);

    await updateVariant(staff, variant.id, { priceBdt: 250 });

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "product.price_changed"));

    expect(entries).toHaveLength(1);
    expect(entries[0].beforeJson).toMatchObject({ priceBdt: 100 });
    expect(entries[0].afterJson).toMatchObject({ priceBdt: 250 });
  });

  it("records a capacity change as its own audit action", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const [variant] = await listVariants(staff, product.id);

    await updateVariant(staff, variant.id, { preorderCapacity: 40 });

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "variant.capacity_changed"));

    expect(entries).toHaveLength(1);
  });
});

describe("enabling and disabling", () => {
  it("a disabled variant is not purchasable but is not deleted", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });

    const variants = await listVariants(staff, product.id);
    await setVariantEnabled(staff, variants[0].id, false);

    const purchasable = await listPurchasableVariants(product.id);
    expect(purchasable).toHaveLength(3);
    await expect(countVariants(product.id)).resolves.toBe(4);
  });

  it("refuses a customer disabling a variant", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const [variant] = await listVariants(staff, product.id);

    await expect(
      setVariantEnabled(customer, variant.id, false),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("bulkUpdateVariants", () => {
  it("applies one change across many variants", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });

    const variants = await listVariants(staff, product.id);
    const count = await bulkUpdateVariants(
      staff,
      variants.map((v) => v.id),
      { priceBdt: 500 },
    );

    expect(count).toBe(4);
    const updated = await listVariants(staff, product.id);
    expect(updated.every((v) => v.priceBdt === 500)).toBe(true);
  });

  it("audits every variant it changes, not just the batch", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });

    const variants = await listVariants(staff, product.id);
    await bulkUpdateVariants(
      staff,
      variants.map((v) => v.id),
      { priceBdt: 500 },
    );

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "product.price_changed"));

    expect(entries).toHaveLength(4);
  });

  it("refuses a customer", async () => {
    const { product } = await seedProductWithAxes();
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const variants = await listVariants(staff, product.id);

    await expect(
      bulkUpdateVariants(customer, [variants[0].id], { priceBdt: 1 }),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("remainingCapacity", () => {
  it("is capacity minus reserved for a preorder variant", () => {
    expect(
      remainingCapacity({
        fulfillmentMode: "preorder",
        preorderCapacity: 40,
        preorderReserved: 12,
      }),
    ).toBe(28);
  });

  it("never reports a negative remainder", () => {
    expect(
      remainingCapacity({
        fulfillmentMode: "preorder",
        preorderCapacity: 5,
        preorderReserved: 9,
      }),
    ).toBe(0);
  });

  it("is null for an in-stock variant, which is governed by stock instead", () => {
    expect(
      remainingCapacity({
        fulfillmentMode: "in_stock",
        preorderCapacity: null,
        preorderReserved: 0,
      }),
    ).toBeNull();
  });

  it("is null when a preorder variant has no ceiling set", () => {
    expect(
      remainingCapacity({
        fulfillmentMode: "preorder",
        preorderCapacity: null,
        preorderReserved: 3,
      }),
    ).toBeNull();
  });
});
