/**
 * The legacy mirror under real catalogue writes (D-070): attribution, state
 * preservation, locks, unattributed changes, and that every staff write path
 * leaves nothing queued.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAttributeDefinitions,
  pkbFactHistory,
  pkbFacts,
  pkbProducts,
  pkbRelationships,
  pkbSyncQueue,
  pkbUnmappedValues,
  pkbVariants,
  products,
  productVariants,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  addVariant,
  createCategory,
  createCategoryAttribute,
  createProduct,
  createProductOption,
  deleteCategoryAttribute,
  deleteProduct,
  duplicateProduct,
  generateVariants,
  listProductOptions,
  removeVariant,
  updateCategoryAttribute,
  updateProduct,
} from "@/lib/catalog";
import {
  addRelationship,
  backfillKnowledge,
  knowledgeReport,
  lockFact,
  PkbLockedError,
  processKnowledgeQueue,
  setFact,
} from "@/lib/pkb";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };

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
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
});

async function factsOf(listingId: string) {
  const [listing] = await harness.db.select().from(products).where(eq(products.id, listingId));
  const rows = await harness.db
    .select({ fact: pkbFacts, key: pkbAttributeDefinitions.key })
    .from(pkbFacts)
    .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbFacts.definitionId))
    .where(eq(pkbFacts.pkbProductId, listing.pkbProductId!));
  const one = (key: string) => rows.find((row) => row.key === key && row.fact.pkbVariantId === null)?.fact;
  return { listing, rows, one };
}

async function queued() {
  return Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbSyncQueue))[0].n);
}

async function history(factId: string) {
  return harness.db.select().from(pkbFactHistory).where(eq(pkbFactHistory.factId, factId)).orderBy(pkbFactHistory.createdAt);
}

describe("staff saves", () => {
  it("records what staff type as MANUAL, attributed, in the same transaction", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, {
      title: "Studio Headphones",
      categoryId: category.id,
      brand: "Harbor Acoustics",
      details: { itemWeight: "250 g", material: "Aluminium" },
    });
    expect(await queued()).toBe(0);

    const { one, listing } = await factsOf(product.id);
    expect(one("item_weight")).toMatchObject({ verificationState: "MANUAL", origin: "MANUAL_ADMIN", decidedBy: staff.id, valueNumber: "250" });
    expect(one("brand")).toMatchObject({ verificationState: "MANUAL", rawValue: "Harbor Acoustics" });
    const [pkb] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, listing.pkbProductId!));
    expect(pkb).toMatchObject({ name: "Studio Headphones", origin: "MANUAL_ADMIN", resolutionState: "UNRESOLVED" });
  });

  it("credits a save only with what it changed; untouched legacy values stay LEGACY", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const [legacy] = await harness.db
      .insert(products)
      .values({ categoryId: category.id, title: "Old Listing", slug: "old", brand: "Sony", details: { material: "Plastic", color: "Black" } })
      .returning();
    await backfillKnowledge();
    const before = await factsOf(legacy.id);
    expect(before.one("material")!.verificationState).toBe("LEGACY");

    // The details panel sends every field, changed or not.
    await updateProduct(staff, legacy.id, { details: { material: "Aluminium", color: "Black" } });
    const after = await factsOf(legacy.id);
    expect(after.one("material")).toMatchObject({ verificationState: "MANUAL", rawValue: "Aluminium", decidedBy: staff.id });
    expect(after.one("color")).toMatchObject({ verificationState: "LEGACY", id: before.one("color")!.id });
    expect(after.one("brand")!.verificationState).toBe("LEGACY");

    const changes = await history(after.one("material")!.id);
    expect(changes.map((row) => [row.changeKind, row.actorUserId])).toEqual([
      ["created", null],
      ["updated", staff.id],
    ]);

    // Saving again with nothing changed writes nothing.
    const count = async () => Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbFactHistory))[0].n);
    const historyRows = await count();
    await updateProduct(staff, legacy.id, { details: { material: "Aluminium", color: "Black" } });
    expect(await count()).toBe(historyRows);
  });

  it("clears a value staff empty, keeping its history", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, { title: "Speaker", categoryId: category.id, details: { material: "Wood" } });
    const { one } = await factsOf(product.id);
    const factId = one("material")!.id;

    await updateProduct(staff, product.id, { details: null });
    expect((await factsOf(product.id)).one("material")).toBeUndefined();
    expect((await history(factId)).map((row) => row.changeKind)).toEqual(["created", "cleared"]);
  });

  it("refuses a save that would overwrite a locked value, and writes nothing", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, { title: "Speaker", categoryId: category.id, details: { itemWeight: "2 kg" } });
    await lockFact(staff, (await factsOf(product.id)).one("item_weight")!.id);

    await expect(updateProduct(staff, product.id, { details: { itemWeight: "3 kg" }, title: "Renamed" })).rejects.toThrow(PkbLockedError);
    const { listing, one } = await factsOf(product.id);
    expect(listing.title).toBe("Speaker");
    expect((listing.details as Record<string, string>).itemWeight).toBe("2 kg");
    expect(one("item_weight")!.rawValue).toBe("2 kg");
  });

  it("settles a change another path left waiting as unattributed before crediting the save", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, { title: "Speaker", categoryId: category.id, brand: "Acme" });
    // A script changes the brand without going through lib/.
    await harness.db.update(products).set({ brand: "Acme Audio" }).where(eq(products.id, product.id));
    expect(await queued()).toBe(1);

    await updateProduct(staff, product.id, { details: { material: "Oak" } });
    const { one } = await factsOf(product.id);
    // The script's change to a MANUAL value was not accepted; the staff edit was.
    expect(one("brand")).toMatchObject({ rawValue: "Acme", verificationState: "MANUAL" });
    expect(one("material")).toMatchObject({ verificationState: "MANUAL", decidedBy: staff.id });
    const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(listing.brand).toBe("Acme");
    expect(await queued()).toBe(0);
  });
});

describe("unattributed changes", () => {
  it("accepts them over LEGACY values and never over values a person decided", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const [legacy] = await harness.db
      .insert(products)
      .values({ categoryId: category.id, title: "Old", slug: "old", details: { material: "Plastic" } })
      .returning();
    await backfillKnowledge();
    const decided = await createProduct(staff, { title: "New", categoryId: category.id, details: { material: "Steel" } });

    await harness.db.update(products).set({ details: { material: "Glass" } }).where(eq(products.id, legacy.id));
    await harness.db.update(products).set({ details: { material: "Gold" } }).where(eq(products.id, decided.id));
    let report = await processKnowledgeQueue(harness.db);
    expect(report.failed).toBe(0);
    // The reverted listing is queued again by its own write-back, and settles.
    report = await processKnowledgeQueue(harness.db);
    expect(report.remaining).toBe(0);

    expect((await factsOf(legacy.id)).one("material")).toMatchObject({ rawValue: "Glass", verificationState: "LEGACY" });
    const kept = await factsOf(decided.id);
    expect(kept.one("material")).toMatchObject({ rawValue: "Steel", verificationState: "MANUAL" });
    expect((kept.listing.details as Record<string, string>).material).toBe("Steel");
    const [parked] = await harness.db
      .select()
      .from(pkbUnmappedValues)
      .where(and(eq(pkbUnmappedValues.productId, decided.id), eq(pkbUnmappedValues.reason, "unattributed_change_not_applied")));
    expect(parked).toMatchObject({ value: "Gold" });
    expect((await knowledgeReport()).ok).toBe(true);
  });
});

describe("every staff write path leaves the mirror current", () => {
  it("options, variants, duplicate, delete and category specifications", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, { title: "Earbuds", categoryId: category.id });
    await createProductOption(staff, product.id, { name: "Colour", values: ["Black", "White"] });
    await generateVariants(staff, product.id, { priceBdt: 1_000_00 });
    expect(await queued()).toBe(0);

    let knowledge = await factsOf(product.id);
    const colours = knowledge.rows.filter((row) => row.key === "color" && row.fact.pkbVariantId).map((row) => row.fact);
    expect(colours.map((fact) => fact.rawValue).sort()).toEqual(["Black", "White"]);
    expect(colours.every((fact) => fact.verificationState === "MANUAL")).toBe(true);

    const [colourOption] = await listProductOptions(product.id);
    await addVariant(staff, product.id, {
      options: [{ attributeId: colourOption.id, value: "Blue" }],
      priceBdt: 1_000_00,
      fulfillmentMode: "preorder",
    });
    expect(await queued()).toBe(0);
    knowledge = await factsOf(product.id);
    expect(
      knowledge.rows.filter((row) => row.key === "color" && row.fact.pkbVariantId).map((row) => row.fact.rawValue).sort(),
    ).toEqual(["Black", "Blue", "White"]);

    const [white] = await harness.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));
    await removeVariant(staff, white.id);
    expect(await queued()).toBe(0);
    knowledge = await factsOf(product.id);
    expect(knowledge.rows.filter((row) => row.fact.pkbVariantId).length).toBe(2);
    expect(await harness.db.select().from(pkbVariants).where(eq(pkbVariants.pkbProductId, knowledge.listing.pkbProductId!))).toHaveLength(2);

    const attribute = await createCategoryAttribute(staff, category.id, { name: "Battery life", dataType: "measurement", unit: "h" });
    await updateProduct(staff, product.id, { attributeValues: { [attribute.id]: "30" } });
    expect((await factsOf(product.id)).one("battery_life")).toMatchObject({ valueNumber: "108000", valueUnit: "s", verificationState: "MANUAL" });
    await deleteCategoryAttribute(staff, attribute.id);
    expect((await factsOf(product.id)).one("battery_life")).toBeUndefined();
    expect(await queued()).toBe(0);

    const copy = await duplicateProduct(staff, product.id);
    expect(await queued()).toBe(0);
    const copied = await factsOf(copy.id);
    expect(copied.listing.pkbProductId).not.toBe(knowledge.listing.pkbProductId);
    expect(copied.rows.every((row) => row.fact.verificationState === "UNVERIFIED")).toBe(true);

    await deleteProduct(staff, copy.id);
    expect(await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, copied.listing.pkbProductId!))).toEqual([]);
    expect((await knowledgeReport()).ok).toBe(true);
  });

  it("keeps a deleted listing's knowledge when it holds knowledge of its own", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const phone = await createProduct(staff, { title: "Phone", categoryId: category.id });
    const case_ = await createProduct(staff, { title: "Case", categoryId: category.id });
    const phoneKnowledge = (await factsOf(phone.id)).listing.pkbProductId!;
    const caseKnowledge = (await factsOf(case_.id)).listing.pkbProductId!;
    await addRelationship(staff, { fromProductId: caseKnowledge, toProductId: phoneKnowledge, kind: "accessory_for" });

    await deleteProduct(staff, phone.id);
    expect(await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, phoneKnowledge))).toHaveLength(1);
    expect(await harness.db.select().from(pkbRelationships)).toHaveLength(1);
  });

  it("moves values to a new definition when a specification's type changes, keeping provenance", async () => {
    const category = await createCategory(staff, { name: "Laptops", slug: "laptops" });
    const attribute = await createCategoryAttribute(staff, category.id, { name: "Memory", dataType: "text" });
    const [legacy] = await harness.db
      .insert(products)
      .values({ categoryId: category.id, title: "Old laptop", slug: "old-laptop", attributeValues: { [attribute.id]: "16" } })
      .returning();
    await backfillKnowledge();
    const original = (await factsOf(legacy.id)).one("memory")!;
    expect(original).toMatchObject({ valueText: "16", verificationState: "LEGACY" });

    await updateCategoryAttribute(staff, attribute.id, { name: "Memory", dataType: "number" });
    await processKnowledgeQueue(harness.db);
    const moved = (await factsOf(legacy.id)).rows.find((row) => row.fact.legacyRef === `products.attribute_values.${attribute.id}`)!;
    expect(moved.key).toBe("memory_2");
    expect(moved.fact).toMatchObject({ valueNumber: "16", verificationState: "LEGACY", sourceId: original.sourceId });
  });
});

describe("writing in the knowledge base", () => {
  it("writes a projectable value back to the listing and detaches a table row it cannot write back", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, {
      title: "Speaker",
      categoryId: category.id,
      specTable: [{ label: "Colour", value: "Red" }],
    });
    const before = await factsOf(product.id);
    const [brandDefinition] = await harness.db.select().from(pkbAttributeDefinitions).where(eq(pkbAttributeDefinitions.key, "brand"));

    await setFact(staff, { pkbProductId: before.listing.pkbProductId!, definitionId: brandDefinition.id, raw: "Harbor Acoustics" });
    let after = await factsOf(product.id);
    expect(after.listing.brand).toBe("Harbor Acoustics");
    expect(after.one("brand")).toMatchObject({ legacyRef: "products.brand", verificationState: "MANUAL" });

    const colour = before.one("color")!;
    await setFact(staff, { pkbProductId: before.listing.pkbProductId!, definitionId: colour.definitionId, raw: "Crimson" });
    after = await factsOf(product.id);
    expect(after.one("color")).toMatchObject({ rawValue: "Crimson", legacyRef: null });
    // The table still says Red; that is now a legacy value that disagrees, parked for a person.
    const parked = await harness.db.select().from(pkbUnmappedValues).where(eq(pkbUnmappedValues.productId, product.id));
    expect(parked).toEqual([expect.objectContaining({ value: "Red", reason: "differs_from_knowledge_value" })]);
    expect(await queued()).toBe(0);
  });

  it("stores not applicable as a value, distinct from unknown", async () => {
    const category = await createCategory(staff, { name: "Audio", slug: "audio" });
    const product = await createProduct(staff, { title: "Speaker", categoryId: category.id });
    const { listing } = await factsOf(product.id);
    const [weight] = await harness.db.select().from(pkbAttributeDefinitions).where(eq(pkbAttributeDefinitions.key, "package_weight"));
    await setFact(staff, { pkbProductId: listing.pkbProductId!, definitionId: weight.id, notApplicable: true });
    expect((await factsOf(product.id)).one("package_weight")).toMatchObject({
      valueStatus: "not_applicable",
      rawValue: null,
      valueNumber: null,
    });
  });
});
