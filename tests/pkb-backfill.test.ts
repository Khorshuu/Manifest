/**
 * Importing existing listings into the Product Knowledge Base (D-069, D-070):
 * nothing lost, nothing invented, nothing promoted to VERIFIED, and a second
 * run changes nothing.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attributes,
  attributeValues,
  categories,
  categoryAttributes,
  pkbAttributeDefinitions,
  pkbBrands,
  pkbFactHistory,
  pkbFacts,
  pkbFamilies,
  pkbIdentifiers,
  pkbProducts,
  pkbUnmappedValues,
  productAttributes,
  products,
  productVariants,
  users,
  variantOptionValues,
} from "@/db/schema";
import { backfillKnowledge, getProductKnowledge, knowledgeReport, resolveFamilySchema } from "@/lib/pkb";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

type Fixture = Awaited<ReturnType<typeof seedLegacyCatalogue>>;
let fixture: Fixture;

/** Listings written straight into the legacy columns, as before the knowledge base existed. */
async function seedLegacyCatalogue() {
  const db = harness.db;
  await db.insert(users).values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" });

  const [electronics] = await db.insert(categories).values({ name: "Electronics", slug: "electronics" }).returning();
  const [audio] = await db.insert(categories).values({ name: "Audio", slug: "audio", parentId: electronics.id }).returning();
  const [headphones] = await db
    .insert(categories)
    .values({ name: "Headphones", slug: "headphones", parentId: audio.id })
    .returning();
  const [kitchen] = await db.insert(categories).values({ name: "Kitchen", slug: "kitchen" }).returning();

  const [warranty] = await db
    .insert(categoryAttributes)
    .values({ categoryId: electronics.id, name: "Warranty years", dataType: "number" })
    .returning();
  const [driver] = await db
    .insert(categoryAttributes)
    .values({ categoryId: headphones.id, name: "Driver size", dataType: "measurement", unit: "mm", sortOrder: 0 })
    .returning();
  const [connectivity] = await db
    .insert(categoryAttributes)
    .values({
      categoryId: headphones.id,
      name: "Connectivity",
      dataType: "multiselect",
      options: ["Bluetooth", "USB-C", "3.5 mm jack"],
      sortOrder: 1,
    })
    .returning();
  const [noiseCancelling] = await db
    .insert(categoryAttributes)
    .values({ categoryId: headphones.id, name: "Noise cancelling", dataType: "boolean", isRequired: true, sortOrder: 2 })
    .returning();

  const [sony] = await db
    .insert(products)
    .values({
      categoryId: headphones.id,
      title: "Sony WH-1000XM6 Wireless Headphones",
      slug: "sony-wh-1000xm6",
      brand: "Sony",
      identifierType: "upc",
      identifierValue: "036000291452",
      details: {
        manufacturer: "Sony Corporation",
        modelNumber: "WH-1000XM6",
        itemWeight: "250 g",
        dimensions: "10 x 5 x 3 cm",
        mystery: "kept as it is",
      },
      attributeValues: {
        [warranty.id]: "2",
        [driver.id]: "40",
        [connectivity.id]: ["Bluetooth", "USB-C"],
        [noiseCancelling.id]: "true",
      },
      specTable: [
        { label: "Item weight", value: "270 g" },
        { label: "Colour", value: "Black" },
        { label: "Frequency response", value: "4 Hz - 40 kHz" },
      ],
      boxContents: ["Headphones", "USB-C cable"],
      compliance: { countryOfOrigin: "Malaysia" },
    })
    .returning();

  const [copyCat] = await db
    .insert(products)
    .values({
      categoryId: kitchen.id,
      title: "Northline Audio Kettle",
      slug: "northline-kettle",
      brand: "Northline Audio",
      identifierType: "upc",
      identifierValue: "036000291452",
    })
    .returning();

  const [thin] = await db
    .insert(products)
    .values({
      categoryId: kitchen.id,
      title: "Northlake Audio Blender",
      slug: "northlake-blender",
      brand: "Northlake Audio",
      details: { releaseDate: "March 2024", itemWeight: "1,5 kg" },
    })
    .returning();

  const [colour] = await db.insert(attributes).values({ name: "Color", productId: sony.id }).returning();
  const [edition] = await db.insert(attributes).values({ name: "Edition", productId: sony.id }).returning();
  const [black, silver] = await db
    .insert(attributeValues)
    .values([
      { attributeId: colour.id, value: "Black" },
      { attributeId: colour.id, value: "Silver" },
    ])
    .returning();
  const [standard] = await db.insert(attributeValues).values({ attributeId: edition.id, value: "Standard" }).returning();
  await db.insert(productAttributes).values([
    { productId: sony.id, attributeId: colour.id, sortOrder: 0 },
    { productId: sony.id, attributeId: edition.id, sortOrder: 1 },
  ]);
  const [blackOffer, silverOffer] = await db
    .insert(productVariants)
    .values([
      { productId: sony.id, sku: "SONY-BLK", priceBdt: 45_000_00 },
      { productId: sony.id, sku: "SONY-SLV", priceBdt: 45_000_00 },
    ])
    .returning();
  await db.insert(variantOptionValues).values([
    { variantId: blackOffer.id, attributeId: colour.id, attributeValueId: black.id },
    { variantId: blackOffer.id, attributeId: edition.id, attributeValueId: standard.id },
    { variantId: silverOffer.id, attributeId: colour.id, attributeValueId: silver.id },
    { variantId: silverOffer.id, attributeId: edition.id, attributeValueId: standard.id },
  ]);

  return { electronics, headphones, kitchen, sony, copyCat, thin, blackOffer, silverOffer, warranty, driver, connectivity, noiseCancelling };
}

async function knowledgeOf(listingId: string) {
  const [listing] = await harness.db.select().from(products).where(eq(products.id, listingId));
  const facts = await harness.db
    .select({ fact: pkbFacts, key: pkbAttributeDefinitions.key })
    .from(pkbFacts)
    .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbFacts.definitionId))
    .where(eq(pkbFacts.pkbProductId, listing.pkbProductId!));
  return { listing, facts };
}

beforeEach(async () => {
  await harness.reset();
  fixture = await seedLegacyCatalogue();
});

describe("backfill", () => {
  it("imports every listing and offer, and reconciles without loss", async () => {
    const result = await backfillKnowledge();
    expect(result).toMatchObject({ processed: 3, failed: 0, remaining: 0 });

    const report = await knowledgeReport();
    expect(report.projectionMismatches).toEqual([]);
    expect(report).toMatchObject({
      listings: 3,
      listingsWithoutKnowledge: 0,
      offers: 2,
      offersWithoutKnowledge: 0,
      queued: 0,
      verifiedWithoutClaim: 0,
      ok: true,
    });
  });

  it("stores legacy values as LEGACY of unknown origin, never VERIFIED or MANUAL", async () => {
    await backfillKnowledge();
    const states = await harness.db
      .select({ state: pkbFacts.verificationState, origin: pkbFacts.origin, n: sql<number>`count(*)::int` })
      .from(pkbFacts)
      .groupBy(pkbFacts.verificationState, pkbFacts.origin);
    expect(states.map((row) => [row.state, row.origin])).toEqual([["LEGACY", "UNKNOWN_LEGACY"]]);

    const identifierStates = await harness.db.select({ state: pkbIdentifiers.verificationState }).from(pkbIdentifiers);
    expect(new Set(identifierStates.map((row) => row.state))).toEqual(new Set(["LEGACY"]));
  });

  it("normalizes what can be read and keeps the raw text beside it", async () => {
    await backfillKnowledge();
    const { facts } = await knowledgeOf(fixture.sony.id);
    const product = facts.filter((row) => row.fact.pkbVariantId === null);
    const byKey = (key: string) => product.filter((row) => row.key === key).map((row) => row.fact);

    expect(byKey("item_weight")).toEqual([
      expect.objectContaining({ rawValue: "250 g", valueNumber: "250", valueUnit: "g", legacyRef: "products.details.itemWeight" }),
    ]);
    expect(byKey("dimensions")[0]).toMatchObject({ valueText: "10 x 5 x 3 cm", valueStatus: "normalized" });
    expect(byKey("warranty_years")[0]).toMatchObject({ valueNumber: "2" });
    // The category stored the unit on the definition; the value was a bare number.
    expect(byKey("driver_size")[0]).toMatchObject({ rawValue: "40", valueNumber: "40", valueUnit: "mm" });
    expect(byKey("noise_cancelling")[0]).toMatchObject({ rawValue: "true", valueBoolean: true });
    expect(byKey("connectivity").map((fact) => [fact.ordinal, fact.rawValue])).toEqual([
      [0, "Bluetooth"],
      [1, "USB-C"],
    ]);
    expect(byKey("box_contents").map((fact) => fact.rawValue)).toEqual(["Headphones", "USB-C cable"]);
    expect(byKey("country_of_origin")[0].rawValue).toBe("Malaysia");
    // A specification row whose label names an attribute exactly.
    expect(byKey("color")[0]).toMatchObject({ rawValue: "Black", rawLabel: "Colour", legacyRef: "products.spec_table" });

    const [brand] = await harness.db.select().from(pkbBrands).where(eq(pkbBrands.id, byKey("brand")[0].valueBrandId!));
    expect(brand).toMatchObject({ name: "Sony", status: "suggested", origin: "UNKNOWN_LEGACY" });

    // Variant-defining values live on the variants, not the product.
    const variantColours = facts.filter((row) => row.fact.pkbVariantId !== null && row.key === "color").map((row) => row.fact.rawValue);
    expect(variantColours.sort()).toEqual(["Black", "Silver"]);
    const offers = await harness.db.select().from(productVariants).where(eq(productVariants.productId, fixture.sony.id));
    expect(offers.every((offer) => offer.pkbVariantId)).toBe(true);
  });

  it("keeps an unreadable value raw rather than guessing", async () => {
    await backfillKnowledge();
    const { facts } = await knowledgeOf(fixture.thin.id);
    const release = facts.find((row) => row.key === "release_date")!.fact;
    const weight = facts.find((row) => row.key === "item_weight")!.fact;
    expect(release).toMatchObject({ valueStatus: "unnormalized", rawValue: "March 2024", valueDate: null });
    expect(weight).toMatchObject({ valueStatus: "unnormalized", rawValue: "1,5 kg", valueNumber: null });
  });

  it("parks what it cannot place, instead of inventing a home for it", async () => {
    await backfillKnowledge();
    const parked = await harness.db
      .select({ ref: pkbUnmappedValues.legacyRef, label: pkbUnmappedValues.label, value: pkbUnmappedValues.value, reason: pkbUnmappedValues.reason })
      .from(pkbUnmappedValues)
      .where(eq(pkbUnmappedValues.productId, fixture.sony.id));
    expect(parked).toEqual(
      expect.arrayContaining([
        { ref: "products.details.mystery", label: "mystery", value: "kept as it is", reason: "no_matching_definition" },
        { ref: "products.spec_table", label: "Item weight", value: "270 g", reason: "conflicts_with_structured_value" },
        { ref: "products.spec_table", label: "Frequency response", value: "4 Hz - 40 kHz", reason: "no_matching_definition" },
        expect.objectContaining({ label: "Edition", value: "Standard", reason: "option_without_definition" }),
      ]),
    );
    // The legacy columns are untouched: the listing still shows everything.
    const [listing] = await harness.db.select().from(products).where(eq(products.id, fixture.sony.id));
    expect((listing.details as Record<string, string>).mystery).toBe("kept as it is");
  });

  it("gives a GTIN to one product only and parks the other", async () => {
    await backfillKnowledge();
    const holders = await harness.db
      .select({ pkbProductId: pkbIdentifiers.pkbProductId })
      .from(pkbIdentifiers)
      .where(eq(pkbIdentifiers.gtin14, "00036000291452"));
    expect(holders).toHaveLength(1);
    const parked = await harness.db
      .select()
      .from(pkbUnmappedValues)
      .where(eq(pkbUnmappedValues.reason, "identifier_in_use"));
    expect(parked).toHaveLength(1);

    const model = await harness.db
      .select()
      .from(pkbIdentifiers)
      .where(eq(pkbIdentifiers.identifierType, "model_number"));
    expect(model).toEqual([expect.objectContaining({ valueRaw: "WH-1000XM6", valueNormalized: "WH1000XM6", validationStatus: "unchecked" })]);
  });

  it("never merges similar brands, but reports them", async () => {
    await backfillKnowledge();
    const names = (await harness.db.select({ name: pkbBrands.name }).from(pkbBrands)).map((row) => row.name).sort();
    expect(names).toEqual(["Northlake Audio", "Northline Audio", "Sony"]);
    const report = await knowledgeReport();
    expect(report.brands.similarPairs.map((pair) => [pair.a, pair.b].sort())).toContainEqual(["Northlake Audio", "Northline Audio"]);
  });

  it("mirrors category specifications as versioned families and never forces a family", async () => {
    await backfillKnowledge();
    const families = await harness.db.select().from(pkbFamilies);
    const electronics = families.find((family) => family.legacyCategoryId === fixture.electronics.id)!;
    const headphones = families.find((family) => family.legacyCategoryId === fixture.headphones.id)!;
    expect(families).toHaveLength(2);
    expect(headphones).toMatchObject({ status: "approved", parentId: electronics.id, origin: "MANIFEST_CREATED" });

    const schema = await resolveFamilySchema(harness.db, headphones.id);
    expect(schema.map((entry) => [entry.definition.key, entry.requirement])).toEqual([
      ["warranty_years", "optional"],
      ["driver_size", "optional"],
      ["connectivity", "optional"],
      ["noise_cancelling", "required"],
    ]);

    const assignments = await harness.db
      .select({ familyId: pkbProducts.familyId, assignment: pkbProducts.familyAssignment, listing: products.id })
      .from(pkbProducts)
      .innerJoin(products, eq(products.pkbProductId, pkbProducts.id));
    expect(assignments.find((row) => row.listing === fixture.sony.id)).toMatchObject({ familyId: headphones.id, assignment: "assigned" });
    // Kitchen defines nothing: its products stay unassigned rather than borrowing a family.
    expect(assignments.find((row) => row.listing === fixture.thin.id)).toMatchObject({ familyId: null, assignment: "unassigned" });

    const [kitchen] = await harness.db.select().from(categories).where(eq(categories.id, fixture.kitchen.id));
    const [headphonesCategory] = await harness.db.select().from(categories).where(eq(categories.id, fixture.headphones.id));
    expect(kitchen.defaultFamilyId).toBeNull();
    expect(headphonesCategory.defaultFamilyId).toBe(headphones.id);
  });

  it("measures completeness against the family: legacy values count, unknown is missing", async () => {
    await backfillKnowledge();
    const [listing] = await harness.db.select().from(products).where(eq(products.id, fixture.sony.id));
    const view = await getProductKnowledge(harness.db, listing.pkbProductId!);
    // Four schema attributes; the two connectivity values are one multi-valued slot.
    expect(view!.schemaSlots).toHaveLength(4);
    expect(view!.completeness).toMatchObject({ legacy: 4, verified: 0, missingRequired: 0 });
    expect(view!.productOnlySlots.map((slot) => slot.definition.key)).toEqual(
      expect.arrayContaining(["brand", "item_weight", "color", "box_contents"]),
    );
  });

  it("is idempotent: a second run writes nothing", async () => {
    await backfillKnowledge();
    const count = async () => ({
      facts: Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbFacts))[0].n),
      history: Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbFactHistory))[0].n),
      products: Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbProducts))[0].n),
      unmapped: Number((await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbUnmappedValues))[0].n),
    });
    const first = await count();
    await backfillKnowledge();
    expect(await count()).toEqual(first);
    expect((await knowledgeReport()).ok).toBe(true);
  });

  it("links no product fact to a variant and no variant fact to another product", async () => {
    await backfillKnowledge();
    const orphans = await harness.db
      .select({ id: pkbFacts.id })
      .from(pkbFacts)
      .where(and(isNull(pkbFacts.pkbVariantId), eq(pkbFacts.legacyRef, "variant_option_values")));
    expect(orphans).toEqual([]);
  });
});
