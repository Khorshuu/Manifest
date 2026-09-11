/**
 * The index keeps itself in step with the catalogue.
 *
 * Migration 0014 puts triggers on every table a listing's words come from, and
 * a deferred trigger rebuilds a product's row at commit. These tests change
 * the catalogue through the application's own functions — never touching the
 * index — and then search, so a trigger that stops firing fails here.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attributeValues,
  attributes,
  auditLog,
  productSearch,
  productSearchQueue,
  productVariants,
  users,
  variantOptionValues,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  archiveProduct,
  createCategory,
  createCategoryAttribute,
  createProduct,
  deleteCategoryAttribute,
  listProductCards,
  updateCategory,
  updateCategoryAttribute,
  updateProduct,
} from "@/lib/catalog";
import {
  processSearchQueue,
  rebuildSearchIndex,
  searchIndexStatus,
} from "@/lib/search/maintenance";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
let categoryId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const [staffRow, customerRow] = await harness.db
    .insert(users)
    .values([
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id });
  staff.id = staffRow.id;
  customer.id = customerRow.id;

  categoryId = (await createCategory(staff, { name: "Laptops", slug: "laptops" })).id;
});

async function seed(title: string) {
  const product = await createProduct(staff, {
    title,
    categoryId,
    status: "preorder_open",
  });
  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
      priceBdt: 100_000_00,
      fulfillmentMode: "preorder",
      preorderCapacity: 10,
      preorderClosesAt: new Date(Date.now() + 7 * 86_400_000),
    })
    .returning({ id: productVariants.id });
  return { ...product, variantId: variant.id };
}

const titles = async (query: string) =>
  (await listProductCards({ query, limit: 20 })).map((card) => card.title);

const queued = async () =>
  (await harness.db.select().from(productSearchQueue)).length;

describe("the index follows the catalogue", () => {
  it("indexes a new product at commit and leaves nothing queued", async () => {
    const product = await seed("Workstation Laptop");

    const [row] = await harness.db
      .select({ title: productSearch.titleNorm })
      .from(productSearch)
      .where(eq(productSearch.productId, product.id));

    expect(row?.title).toBe("workstation laptop");
    expect(await queued()).toBe(0);
    expect(await titles("workstation")).toEqual(["Workstation Laptop"]);
  });

  it("follows a renamed product", async () => {
    const product = await seed("Workstation Laptop");
    // The slug is given so updateProduct does not derive one: that lookup
    // runs outside its transaction, which a one-connection PGlite cannot serve
    // while the transaction is open.
    await updateProduct(staff, product.id, {
      title: "Studio Notebook",
      slug: "studio-notebook",
    });

    expect(await titles("workstation")).toEqual([]);
    expect(await titles("notebook")).toEqual(["Studio Notebook"]);
  });

  it("drops an unpublished or archived product from results at once", async () => {
    const draft = await seed("Travel Laptop");
    const archived = await seed("Gaming Laptop");

    await updateProduct(staff, draft.id, { status: "draft" });
    await archiveProduct(staff, archived.id);

    expect(await titles("laptop")).toEqual([]);
  });

  it("follows the variants: an option added is searchable, a disabled one is not", async () => {
    const product = await seed("Everyday Laptop");

    const [colour] = await harness.db
      .insert(attributes)
      .values({ name: "Colour" })
      .returning({ id: attributes.id });
    const [silver] = await harness.db
      .insert(attributeValues)
      .values({ attributeId: colour.id, value: "Moonstone", sortOrder: 0 })
      .returning({ id: attributeValues.id });

    await harness.db.insert(variantOptionValues).values({
      variantId: product.variantId,
      attributeId: colour.id,
      attributeValueId: silver.id,
    });
    expect(await titles("moonstone")).toEqual(["Everyday Laptop"]);

    await harness.db
      .update(productVariants)
      .set({ isEnabled: false })
      .where(eq(productVariants.id, product.variantId));
    expect(await titles("moonstone")).toEqual([]);
  });

  it("follows a renamed option value", async () => {
    const product = await seed("Everyday Laptop");
    const [colour] = await harness.db
      .insert(attributes)
      .values({ name: "Colour" })
      .returning({ id: attributes.id });
    const [value] = await harness.db
      .insert(attributeValues)
      .values({ attributeId: colour.id, value: "Moonstone", sortOrder: 0 })
      .returning({ id: attributeValues.id });
    await harness.db.insert(variantOptionValues).values({
      variantId: product.variantId,
      attributeId: colour.id,
      attributeValueId: value.id,
    });

    await harness.db
      .update(attributeValues)
      .set({ value: "Graphite" })
      .where(eq(attributeValues.id, value.id));

    expect(await titles("moonstone")).toEqual([]);
    expect(await titles("graphite")).toEqual(["Everyday Laptop"]);
  });

  it("follows a renamed category", async () => {
    await seed("Everyday Machine");
    await updateCategory(staff, categoryId, { name: "Notebooks", slug: "laptops" });

    expect(await titles("notebooks")).toEqual(["Everyday Machine"]);
  });

  it("follows a category specification from answer to rename to removal", async () => {
    const product = await seed("Everyday Machine");
    const processor = await createCategoryAttribute(staff, categoryId, {
      name: "Processor",
      dataType: "text",
    });

    await updateProduct(staff, product.id, {
      attributeValues: { [processor.id]: "Quasar X9" },
    });
    expect(await titles("quasar")).toEqual(["Everyday Machine"]);

    await updateCategoryAttribute(staff, processor.id, {
      name: "Chip",
      dataType: "text",
      isSearchable: false,
    });
    expect(await titles("quasar")).toEqual([]);

    await updateCategoryAttribute(staff, processor.id, {
      name: "Chip",
      dataType: "text",
      isSearchable: true,
    });
    expect(await titles("quasar")).toEqual(["Everyday Machine"]);

    await deleteCategoryAttribute(staff, processor.id);
    expect(await titles("quasar")).toEqual([]);
  });

  it("does not reindex for a capacity or stock change", async () => {
    const product = await seed("Everyday Laptop");
    const [before] = await harness.db
      .select({ at: productSearch.indexedAt })
      .from(productSearch)
      .where(eq(productSearch.productId, product.id));

    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 3, stockQuantity: 4 })
      .where(eq(productVariants.id, product.variantId));

    const [after] = await harness.db
      .select({ at: productSearch.indexedAt })
      .from(productSearch)
      .where(eq(productSearch.productId, product.id));

    expect(after.at.getTime()).toBe(before.at.getTime());
    expect(await queued()).toBe(0);
  });
});

describe("maintenance", () => {
  it("rebuilds every row on request, for staff only, and audits it", async () => {
    await seed("Everyday Laptop");
    await seed("Travel Laptop");

    await expect(rebuildSearchIndex(customer)).rejects.toMatchObject({ status: 403 });
    expect(await rebuildSearchIndex(staff)).toEqual({ products: 2 });

    const audit = await harness.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, "search.reindexed"));
    expect(audit).toHaveLength(1);
  });

  it("retries a product a failed rebuild left queued", async () => {
    const product = await seed("Everyday Laptop");

    // Leave a row behind the way a failed rebuild would: without the trigger
    // that would otherwise process it at commit.
    await harness.client.exec(
      "alter table product_search_queue disable trigger product_search_queue_process",
    );
    await harness.db.delete(productSearch).where(eq(productSearch.productId, product.id));
    await harness.db.insert(productSearchQueue).values({ productId: product.id });
    await harness.client.exec(
      "alter table product_search_queue enable trigger product_search_queue_process",
    );

    expect(await searchIndexStatus(staff)).toMatchObject({ missing: 1, queued: 1 });
    expect(await titles("everyday")).toEqual([]);

    expect(await processSearchQueue()).toEqual({ rebuilt: 1, failed: 0 });
    expect(await searchIndexStatus(staff)).toMatchObject({ missing: 0, queued: 0 });
    expect(await titles("everyday")).toEqual(["Everyday Laptop"]);
  });

  it("reports the index state to staff only", async () => {
    await seed("Everyday Laptop");
    await expect(searchIndexStatus(customer)).rejects.toMatchObject({ status: 403 });
    expect(await searchIndexStatus(staff)).toMatchObject({
      products: 1,
      indexed: 1,
      missing: 0,
      queued: 0,
    });
  });

  it("keeps the vocabulary for corrections in step too", async () => {
    const product = await seed("Everyday Laptop");
    await updateProduct(staff, product.id, {
      title: "Everyday Chromebook",
      slug: "everyday-chromebook",
    });

    const words = await harness.db.execute(
      sql`select word from product_search_words where product_id = ${product.id}`,
    );
    const list = (words as unknown as { rows: { word: string }[] }).rows.map((row) => row.word);
    expect(list).toContain("chromebook");
    expect(list).not.toContain("laptop");
  });
});
