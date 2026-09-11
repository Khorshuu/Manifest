/**
 * The search engine: ranking, codes, typo tolerance, synonyms, the staff
 * controls, and suggestions.
 *
 * Every case seeds real products through `createProduct` and lets the database
 * build their index rows — nothing here writes to `product_search` by hand, so
 * each test also proves the triggers kept the index in step.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, productVariants, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  discover,
  getPublicProductBySlug,
  listProductCards,
  updateProduct,
} from "@/lib/catalog";
import { correctSearch, planSearch } from "@/lib/search/plan";
import { suggest, suggestSearch } from "@/lib/search/suggest";
import { SynonymError, createSynonym } from "@/lib/search/synonyms";
import { synonymInputSchema } from "@/lib/validation/search";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };

let electronicsId = "";
let phonesId = "";

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

  electronicsId = (
    await createCategory(staff, { name: "Electronics", slug: "electronics" })
  ).id;
  phonesId = (
    await createCategory(staff, {
      name: "Phones",
      slug: "phones",
      parentId: electronicsId,
    })
  ).id;
});

async function seed(options: {
  title: string;
  brand?: string;
  categoryId?: string;
  descriptionHtml?: string;
  bulletFeatures?: string[];
  sku?: string;
  priceBdt?: number;
  costPriceUsd?: number;
  status?: "preorder_open" | "draft";
}) {
  const product = await createProduct(staff, {
    title: options.title,
    categoryId: options.categoryId ?? electronicsId,
    brand: options.brand,
    descriptionHtml: options.descriptionHtml,
    bulletFeatures: options.bulletFeatures,
    status: options.status ?? "preorder_open",
  });

  await harness.db.insert(productVariants).values({
    productId: product.id,
    sku: options.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`,
    priceBdt: options.priceBdt ?? 5_000_00,
    costPriceUsd: options.costPriceUsd ?? null,
    fulfillmentMode: "preorder",
    preorderClosesAt: new Date(Date.now() + 7 * 86_400_000),
  });

  return product;
}

const titles = async (query: string) =>
  (await listProductCards({ query, limit: 20 })).map((card) => card.title);

describe("ranking", () => {
  it("puts the exact name above a longer name containing it, and both above a mention", async () => {
    await seed({ title: "iPhone 15 Silicone Case", brand: "Casely" });
    await seed({ title: "Apple iPhone 15", brand: "Apple" });
    await seed({
      title: "Desk Lamp",
      descriptionHtml: "<p>Tall enough to light an iPhone 15 on the desk.</p>",
    });

    const order = await titles("iphone 15");

    expect(order.indexOf("Apple iPhone 15")).toBe(0);
    expect(order.indexOf("iPhone 15 Silicone Case")).toBe(1);
    expect(order.indexOf("Desk Lamp")).toBe(2);
  });

  it("lets a search for a brand put that brand first", async () => {
    await seed({ title: "Laces for Nike trainers", brand: "Lacecraft" });
    await seed({ title: "Air Max 90", brand: "Nike" });

    expect((await titles("nike"))[0]).toBe("Air Max 90");
  });

  it("never lets the staff boost lift a weaker match above a stronger one", async () => {
    const lamp = await seed({
      title: "Desk Lamp",
      descriptionHtml: "<p>Sits beside a mechanical keyboard.</p>",
    });
    await seed({ title: "Mechanical Keyboard" });
    await updateProduct(staff, lamp.id, { searchBoost: 2 });

    expect((await titles("mechanical keyboard"))[0]).toBe("Mechanical Keyboard");
  });

  it("uses the boost to order products that are equally relevant", async () => {
    await seed({ title: "Travel Mug Blue" });
    const green = await seed({ title: "Travel Mug Green" });

    await updateProduct(staff, green.id, { searchBoost: 2 });
    expect((await titles("travel mug"))[0]).toBe("Travel Mug Green");
  });

  it("refuses a boost outside the five steps", async () => {
    const product = await seed({ title: "Kettle" });
    await expect(
      harness.db
        .update(products)
        .set({ searchBoost: 9 })
        .where(eq(products.id, product.id)),
    ).rejects.toThrow();
  });
});

describe("codes", () => {
  it("finds a product by its SKU, with or without the punctuation", async () => {
    const product = await seed({ title: "Field Recorder" });
    await updateProduct(staff, product.id, { sku: "ABC-123" });

    expect(await titles("ABC-123")).toEqual(["Field Recorder"]);
    expect(await titles("abc123")).toEqual(["Field Recorder"]);
  });

  it("finds a product by a variant SKU, a barcode and a model number", async () => {
    const product = await seed({ title: "Studio Monitors", sku: "HA-MON-2291" });
    await updateProduct(staff, product.id, {
      identifierType: "upc",
      identifierValue: "0123456789012",
      details: { modelNumber: "MTP03LL/A" },
    });
    await seed({ title: "Unrelated Speaker" });

    expect(await titles("HA-MON-2291")).toEqual(["Studio Monitors"]);
    expect(await titles("0123456789012")).toEqual(["Studio Monitors"]);
    expect(await titles("MTP03LL/A")).toEqual(["Studio Monitors"]);
  });
});

describe("typo tolerance", () => {
  it("needs no correction for a prefix or a stem", async () => {
    await seed({ title: "Apple iPhone 15", brand: "Apple" });
    await seed({ title: "AirPods Pro", brand: "Apple" });
    await seed({ title: "Studio Headphones" });

    expect(await titles("iphon")).toEqual(["Apple iPhone 15"]);
    expect(await titles("airpod")).toEqual(["AirPods Pro"]);
    expect(await titles("headphons")).toEqual(["Studio Headphones"]);
  });

  it("corrects a misspelled brand to the listing's own spelling", async () => {
    await seed({ title: "Galaxy S24", brand: "Samsung" });

    const plan = await planSearch("samsng");
    expect(await listProductCards({ plan })).toHaveLength(0);

    const corrected = await correctSearch(plan!);
    expect(corrected?.query).toBe("Samsung");
    expect(corrected?.correctedFrom).toBe("samsng");
    expect((await listProductCards({ plan: corrected })).map((card) => card.title)).toEqual([
      "Galaxy S24",
    ]);
  });

  it("corrects a word that only appears in a highlight", async () => {
    await seed({ title: "Travel Speaker", bulletFeatures: ["Bluetooth 5.3, twelve hours"] });

    const corrected = await correctSearch((await planSearch("bluetooh speaker"))!);
    expect(corrected?.query.toLowerCase()).toBe("bluetooth speaker");
  });

  it("does not correct a search that already finds something", async () => {
    await seed({ title: "Studio Headphones" });
    expect(await correctSearch((await planSearch("stud"))!)).toBeNull();
  });

  it("applies a correction only when nothing matched, and says so", async () => {
    await seed({ title: "Galaxy S24", brand: "Samsung" });

    const result = await discover({ params: { q: "samsng" } });
    expect(result.correctedFrom).toBe("samsng");
    expect(result.total).toBe(1);
    expect(result.products[0].title).toBe("Galaxy S24");
  });

  it("searches exactly what was typed when asked to", async () => {
    await seed({ title: "Galaxy S24", brand: "Samsung" });

    const result = await discover({ params: { q: "samsng", spell: "0" } });
    expect(result.correctedFrom).toBeNull();
    expect(result.total).toBe(0);
  });

  it("never corrects towards a word only a draft uses", async () => {
    await seed({ title: "Secret Samsung Drop", status: "draft" });
    expect(await correctSearch((await planSearch("samsng"))!)).toBeNull();
  });
});

describe("synonyms", () => {
  const add = (term: string, synonyms: string[], bidirectional = true) =>
    createSynonym(staff, synonymInputSchema.parse({ term, synonyms, bidirectional }));

  it("works both ways when two-way", async () => {
    await seed({ title: "Wireless Earbuds" });
    await seed({ title: "Bedside Earphones" });
    await add("earbuds", ["earphones"]);

    expect((await titles("earbuds")).sort()).toEqual(["Bedside Earphones", "Wireless Earbuds"]);
    expect((await titles("earphones")).sort()).toEqual(["Bedside Earphones", "Wireless Earbuds"]);
  });

  it("only widens the first word when one-way", async () => {
    await seed({ title: "Leather Couch" });
    await seed({ title: "Sofa Cover" });
    await add("sofa", ["couch"], false);

    expect((await titles("sofa")).sort()).toEqual(["Leather Couch", "Sofa Cover"]);
    expect(await titles("couch")).toEqual(["Leather Couch"]);
  });

  it("matches a phrase", async () => {
    await seed({ title: "Cast Iron Skillet" });
    await add("frying pan", ["skillet"], false);

    expect(await titles("frying pan")).toEqual(["Cast Iron Skillet"]);
  });

  it("normalises what it stores", () => {
    const parsed = synonymInputSchema.parse({ term: " Air-Pods ", synonyms: ["AirPods", "air pods"] });
    expect(parsed).toEqual({ term: "air pods", synonyms: ["airpods"], bidirectional: true });
  });

  it("refuses a duplicate term and records who wrote each one", async () => {
    await add("mobile", ["phone"], false);
    await expect(add("mobile", ["cellphone"])).rejects.toBeInstanceOf(SynonymError);

    const audit = await harness.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.action, "search.synonym_created"));
    expect(audit).toEqual([{ action: "search.synonym_created", actor: staff.id }]);
  });

  it("cannot be written by a customer", async () => {
    await expect(
      createSynonym(customer, synonymInputSchema.parse({ term: "cheap", synonyms: ["free"] })),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("hidden from search", () => {
  it("leaves search and suggestions but keeps its page and its shelf", async () => {
    const product = await seed({ title: "Gooseneck Kettle" });
    await updateProduct(staff, product.id, { searchable: false });

    expect(await titles("kettle")).toEqual([]);
    expect(await suggestSearch("kett")).toHaveLength(0);
    expect(await getPublicProductBySlug(product.slug)).not.toBeNull();
    expect(
      (await listProductCards({ categoryIds: [electronicsId] })).map((card) => card.title),
    ).toContain("Gooseneck Kettle");
  });
});

describe("suggestions", () => {
  it("completes a search from the names of what matches", async () => {
    await seed({ title: "Apple iPhone 15", brand: "Apple", categoryId: phonesId });
    await seed({ title: "Apple iPhone 15 Pro", brand: "Apple", categoryId: phonesId });
    await seed({ title: "Silicone Case for iPhone 15", brand: "Casely", categoryId: phonesId });

    const searches = (await suggestSearch("iph"))
      .filter((suggestion) => suggestion.kind === "search")
      .map((suggestion) => suggestion.label);

    expect(searches).toContain("iPhone 15");
    expect(searches).toContain("iPhone 15 Pro");
    expect(searches).toContain("iPhone Case");
  });

  it("names the shelf the matches sit on", async () => {
    await seed({ title: "Apple iPhone 15", brand: "Apple", categoryId: phonesId });

    const shelf = (await suggestSearch("iphone")).find(
      (suggestion) => suggestion.kind === "category" && suggestion.scope,
    );
    expect(shelf).toMatchObject({ label: "Phones", scope: "iphone" });
    expect(shelf?.href).toContain("category=phones");
  });

  it("carries the price a shopper would pay, and never the sourcing cost", async () => {
    await seed({ title: "Mechanical Keyboard", priceBdt: 12_345_00, costPriceUsd: 98_765 });

    const [product] = (await suggestSearch("mech")).filter(
      (suggestion) => suggestion.kind === "product",
    );
    expect(product.priceBdt).toBe(12_345_00);
    expect(JSON.stringify(await suggestSearch("mech"))).not.toContain("98765");
  });

  it("follows a correction when nothing matches as typed", async () => {
    await seed({ title: "Galaxy S24", brand: "Samsung" });

    const result = await suggest("samsng");
    expect(result.correctedQuery).toBe("Samsung");
    expect(result.suggestions.find((entry) => entry.kind === "product")?.label).toBe("Galaxy S24");
  });
});
