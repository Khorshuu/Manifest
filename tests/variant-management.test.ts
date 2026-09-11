/**
 * Managing variants by hand: adding one (with a value the option did not have
 * yet), deleting one nothing references, archiving one with history instead
 * of deleting it, restoring it, and the permission gate.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attributeValues, productVariants, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  addVariant,
  createAttribute,
  createCategory,
  createProduct,
  generateVariants,
  removeVariant,
  restoreVariant,
  setProductAttributes,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "customer@example.com", role: "customer" };
let productId = "";
let colourId = "";

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
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === staff.email)!.id;
  customer.id = rows.find((row) => row.email === customer.email)!.id;

  const category = await createCategory(staff, { name: "Kitchen", slug: "kitchen" });
  productId = (await createProduct(staff, { title: "Travel Mug", categoryId: category.id })).id;
  colourId = (await createAttribute(staff, { name: "Colour", inputType: "select", values: ["Black", "White"] })).id;
  await setProductAttributes(staff, productId, [colourId]);
  await generateVariants(staff, productId, { priceBdt: 100_000 });
});

describe("adding a variant by hand", () => {
  it("adds a combination with a brand-new value and creates the value", async () => {
    const variant = await addVariant(staff, productId, {
      options: [{ attributeId: colourId, value: "Teal" }],
      priceBdt: 150_000,
      fulfillmentMode: "in_stock",
    });
    expect(variant.label).toBe("Teal");
    const values = await harness.db.select().from(attributeValues).where(eq(attributeValues.attributeId, colourId));
    expect(values.map((value) => value.value)).toContain("Teal");
    const [row] = await harness.db.select().from(productVariants).where(eq(productVariants.id, variant.id));
    expect(row.priceBdt).toBe(150_000);
    expect(row.fulfillmentMode).toBe("in_stock");
  });

  it("refuses a combination that already exists, matching case-insensitively", async () => {
    await expect(
      addVariant(staff, productId, { options: [{ attributeId: colourId, value: "black" }], priceBdt: 0, fulfillmentMode: "preorder" }),
    ).rejects.toThrow(/already exists/);
  });

  it("requires a value for every option", async () => {
    await expect(addVariant(staff, productId, { options: [], priceBdt: 0, fulfillmentMode: "preorder" })).rejects.toThrow(/colour/i);
  });

  it("refuses a customer", async () => {
    await expect(
      addVariant(customer, productId, { options: [{ attributeId: colourId, value: "Red" }], priceBdt: 0, fulfillmentMode: "preorder" }),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe("removing a variant", () => {
  it("deletes a variant nothing references", async () => {
    const [first] = await harness.db.select().from(productVariants).where(eq(productVariants.productId, productId));
    expect(await removeVariant(staff, first.id)).toEqual({ mode: "deleted" });
    const left = await harness.db.select().from(productVariants).where(eq(productVariants.id, first.id));
    expect(left).toHaveLength(0);
  });

  it("archives a variant with reserved places instead of deleting it, and restores it", async () => {
    const [first] = await harness.db.select().from(productVariants).where(eq(productVariants.productId, productId));
    await harness.db
      .update(productVariants)
      .set({ preorderCapacity: 10, preorderReserved: 2 })
      .where(eq(productVariants.id, first.id));

    expect(await removeVariant(staff, first.id)).toEqual({ mode: "archived" });
    const [archived] = await harness.db.select().from(productVariants).where(eq(productVariants.id, first.id));
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.isEnabled).toBe(false);

    await restoreVariant(staff, first.id);
    const [restored] = await harness.db.select().from(productVariants).where(eq(productVariants.id, first.id));
    expect(restored.archivedAt).toBeNull();
    expect(restored.isEnabled).toBe(true);
  });

  it("refuses a customer", async () => {
    const [first] = await harness.db.select().from(productVariants).where(eq(productVariants.productId, productId));
    await expect(removeVariant(customer, first.id)).rejects.toThrow(AuthorizationError);
  });
});
