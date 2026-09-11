/**
 * The product lifecycle actions behind Admin → Products: publish (with the
 * readiness checks reported one by one), unpublish, duplicate, delete — and
 * delete refusing anything with history.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productImages, productVariants, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  deleteProduct,
  duplicateProduct,
  generateVariants,
  inferLiveStatus,
  listProductsForAdmin,
  NotReadyError,
  publishProduct,
  unpublishProduct,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "customer@example.com", role: "customer" };
let productId = "";

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

  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  productId = (await createProduct(staff, { title: "Travel Headphones", categoryId: category.id, sku: "TH-1" })).id;
});

async function makeReady() {
  await harness.db.insert(productImages).values({ productId, url: "/a.jpg", altText: "Headphones", sortOrder: 0 });
  await generateVariants(staff, productId, { priceBdt: 250_000, fulfillmentMode: "in_stock" });
}

describe("publishing", () => {
  it("reports each failing check so the screen can point at it", async () => {
    try {
      await publishProduct(staff, productId, "in_stock");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotReadyError);
      const ids = (error as NotReadyError).checks.map((check) => check.id);
      expect(ids).toEqual(expect.arrayContaining(["image", "variant"]));
    }
  });

  it("publishes a ready product as in stock, and unpublishes it back to draft", async () => {
    await makeReady();
    expect(await inferLiveStatus(productId)).toBe("in_stock");
    await publishProduct(staff, productId, await inferLiveStatus(productId));
    let [row] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(row.status).toBe("in_stock");

    await unpublishProduct(staff, productId);
    [row] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(row.status).toBe("draft");
  });

  it("refuses a customer", async () => {
    await expect(unpublishProduct(customer, productId)).rejects.toThrow(AuthorizationError);
  });
});

describe("duplicating", () => {
  it("copies the product as a draft with its photos and variants, clearing what must be unique", async () => {
    await makeReady();
    await harness.db.update(productVariants).set({ stockQuantity: 9 }).where(eq(productVariants.productId, productId));
    const copy = await duplicateProduct(staff, productId);

    const [row] = await harness.db.select().from(products).where(eq(products.id, copy.id));
    expect(row.title).toBe("Travel Headphones (copy)");
    expect(row.status).toBe("draft");
    expect(row.sku).toBeNull();
    expect(row.slug).not.toBe("travel-headphones");

    const images = await harness.db.select().from(productImages).where(eq(productImages.productId, copy.id));
    expect(images).toHaveLength(1);
    const variants = await harness.db.select().from(productVariants).where(eq(productVariants.productId, copy.id));
    expect(variants).toHaveLength(1);
    expect(variants[0].sku).toMatch(/-COPY/);
    expect(variants[0].stockQuantity).toBe(0);
    expect(variants[0].priceBdt).toBe(250_000);
  });
});

describe("deleting", () => {
  it("deletes a product nothing depends on", async () => {
    await makeReady();
    await deleteProduct(staff, productId);
    const left = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(left).toHaveLength(0);
  });

  it("refuses one with reserved places and says to archive instead", async () => {
    await makeReady();
    await harness.db
      .update(productVariants)
      .set({ fulfillmentMode: "preorder", preorderCapacity: 10, preorderReserved: 1, stockQuantity: null })
      .where(eq(productVariants.productId, productId));
    await expect(deleteProduct(staff, productId)).rejects.toThrow(/Archive it instead/);
  });

  it("refuses a customer", async () => {
    await expect(deleteProduct(customer, productId)).rejects.toThrow(AuthorizationError);
  });
});

describe("the list", () => {
  it("reports low stock and uncapped preorders for the inventory filters", async () => {
    await makeReady();
    await harness.db
      .update(productVariants)
      .set({ stockQuantity: 2, lowStockThreshold: 5 })
      .where(eq(productVariants.productId, productId));
    const [row] = await listProductsForAdmin(staff);
    expect(row.lowStockVariants).toBe(1);
    expect(row.uncappedPreorders).toBe(0);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
