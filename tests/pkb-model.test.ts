/**
 * The Product Knowledge Base data model: the rules the database enforces on
 * its own (migration 0031), and the family, claim, relationship, alias and
 * export services built on them.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAttributeDefinitions,
  pkbClaims,
  pkbFacts,
  pkbFamilies,
  pkbFamilyVersions,
  pkbProducts,
  pkbSources,
  products,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import {
  activateFamilyVersion,
  addRelationship,
  approveFamily,
  assignFamily,
  decideAlias,
  draftFamilyVersion,
  exportEligibility,
  getProductKnowledge,
  listRelationships,
  lockFact,
  proposeFactClaim,
  recordEvidence,
  recordSource,
  rejectFamily,
  resolveFamilySchema,
  setFact,
  suggestAlias,
  suggestFamily,
} from "@/lib/pkb";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const owner: SessionUser = { id: "", email: "owner@example.com", role: "super_admin" };
const productManager: SessionUser = { id: "", email: "pm@example.com", role: "product_manager" };
const marketing: SessionUser = { id: "", email: "marketing@example.com", role: "marketing" };
const customer: SessionUser = { id: "", email: "customer@example.com", role: "customer" };

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
    .values([owner, productManager, marketing, customer].map((user) => ({ email: user.email, passwordHash: "x", role: user.role })))
    .returning({ id: users.id, email: users.email });
  for (const user of [owner, productManager, marketing, customer]) user.id = rows.find((row) => row.email === user.email)!.id;
});

/** A listing with its knowledge product; returns ids and a few definitions. */
async function knowledgeProduct(title = "Studio Headphones") {
  const category = await createCategory(owner, { name: `Shelf ${title}`, slug: `shelf-${title.toLowerCase().replace(/\W+/g, "-")}` });
  const listing = await createProduct(owner, { title, categoryId: category.id, details: { itemWeight: "250 g" } });
  const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
  const definitions = new Map(
    (await harness.db.select().from(pkbAttributeDefinitions)).map((definition) => [definition.key, definition]),
  );
  return { listingId: listing.id, pkbProductId: row.pkbProductId!, definitions };
}

/** Runs raw SQL expected to be refused by the database. */
async function refused(statement: string, pattern: RegExp) {
  let error: unknown = null;
  try {
    await harness.client.exec(`begin; ${statement}; commit;`);
  } catch (caught) {
    error = caught;
  } finally {
    // Always leave the single connection usable, whatever happened.
    await harness.client.exec("rollback").catch(() => undefined);
  }
  expect(error, `expected the database to refuse: ${statement}`).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

describe("rules the database enforces", () => {
  it("refuses VERIFIED without an accepted claim and a decision, and LEGACY outside unknown origin", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct();
    const weight = definitions.get("item_weight")!.id;
    const [fact] = await harness.db.select().from(pkbFacts).where(eq(pkbFacts.definitionId, weight));

    await refused(`update pkb_facts set verification_state = 'VERIFIED' where id = '${fact.id}'`, /pkb_facts_verified_check/);
    await refused(`update pkb_facts set verification_state = 'LEGACY' where id = '${fact.id}'`, /pkb_facts_legacy_check/);
    await refused(`update pkb_facts set verification_state = 'MANUAL', decided_by = null where id = '${fact.id}'`, /pkb_facts_manual_check/);
    expect(pkbProductId).toBeTruthy();
  });

  it("keeps unknown, not applicable and values apart, and a value in its definition's shape", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct();
    const [source] = await harness.db.select().from(pkbSources).limit(1);
    const insert = (definition: string, columns: string, values: string) =>
      `insert into pkb_facts (pkb_product_id, definition_id, verification_state, origin, source_id, decided_by, ${columns})
       values ('${pkbProductId}', '${definitions.get(definition)!.id}', 'MANUAL', 'MANUAL_ADMIN', '${source.id}', '${owner.id}', ${values})`;

    await refused(insert("material", "value_status, raw_value, value_text", "'not_applicable', 'x', 'x'"), /pkb_facts_value_shape_check/);
    await refused(insert("material", "value_status, raw_value", "'normalized', 'Steel'"), /shape attribute material|pkb_facts_value_shape_check/);
    // A quantity without its unit is not the shape item_weight needs.
    await refused(insert("package_weight", "value_status, raw_value, value_number", "'normalized', '2', 2"), /shape attribute package_weight/);
    // A single-valued attribute has one slot.
    await refused(insert("material", "value_status, raw_value, value_text, ordinal", "'normalized', 'Steel', 'Steel', 1"), /takes a single value/);
    // Not applicable, false and zero are all storable values.
    await harness.client.exec(insert("material", "value_status", "'not_applicable'"));
  });

  it("keeps history append-only, but lets a whole product record go", async () => {
    const { pkbProductId } = await knowledgeProduct();
    await refused(`update pkb_fact_history set reason = 'rewritten'`, /append-only/);
    await refused(`delete from pkb_fact_history`, /append-only/);
    await harness.client.exec(`update products set pkb_product_id = null; delete from pkb_products where id = '${pkbProductId}'`);
    expect(await harness.db.select().from(pkbProducts)).toEqual([]);
  });

  it("allows no AI source type, and AI-assisted evidence must quote its source", async () => {
    const { pkbProductId } = await knowledgeProduct();
    await refused(
      `insert into pkb_sources (source_type, acquisition_method, origin) values ('ai_generated', 'system', 'MANIFEST_CREATED')`,
      /pkb_sources_source_type_check/,
    );
    const [source] = await harness.db
      .insert(pkbSources)
      .values({ sourceType: "retailer", acquisitionMethod: "staff_url", origin: "APPROVED_EXTERNAL_SOURCE", url: "https://shop.example/p", urlNormalized: "https://shop.example/p" })
      .returning();
    await refused(
      `insert into pkb_evidence (source_id, pkb_product_id, extraction_method) values ('${source.id}', '${pkbProductId}', 'ai_assisted')`,
      /pkb_evidence_ai_quotes_check/,
    );
  });

  it("gives a GTIN to one product, and a variant fact only to its own product's variant", async () => {
    const first = await knowledgeProduct("First");
    const second = await knowledgeProduct("Second");
    const [source] = await harness.db.select().from(pkbSources).limit(1);
    const identifier = (product: string) =>
      `insert into pkb_identifiers (pkb_product_id, identifier_type, value_raw, value_normalized, gtin14, validation_status, verification_state, origin, source_id, decided_by)
       values ('${product}', 'gtin12', '036000291452', '036000291452', '00036000291452', 'valid', 'MANUAL', 'MANUAL_ADMIN', '${source.id}', '${owner.id}')`;
    await harness.client.exec(identifier(first.pkbProductId));
    await refused(identifier(second.pkbProductId), /pkb_identifiers_gtin_unique/);

    const [variant] = await harness.client.query<{ id: string }>(
      `insert into pkb_variants (pkb_product_id, origin) values ('${first.pkbProductId}', 'MANUAL_ADMIN') returning id`,
    ).then((result) => result.rows);
    await refused(
      `insert into pkb_facts (pkb_product_id, pkb_variant_id, definition_id, value_status, raw_value, value_text, verification_state, origin, source_id, decided_by)
       values ('${second.pkbProductId}', '${variant.id}', '${second.definitions.get("color")!.id}', 'normalized', 'Red', 'Red', 'MANUAL', 'MANUAL_ADMIN', '${source.id}', '${owner.id}')`,
      /pkb_facts_variant_fk/,
    );
  });

  it("makes an attribute key permanent and its type fixed once values exist", async () => {
    const { definitions } = await knowledgeProduct();
    await refused(`update pkb_attribute_definitions set key = 'weight' where key = 'item_weight'`, /permanent/);
    await refused(`update pkb_attribute_definitions set data_type = 'text', unit_dimension = null where key = 'item_weight'`, /cannot change/);
    expect(definitions.get("item_weight")!.dataType).toBe("quantity");
  });
});

describe("product families", () => {
  it("lets a manager suggest a family for an unplaced product; only knowledge.manage approves it", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct("Pour-over Kettle");
    const family = await suggestFamily(productManager, {
      name: "Kettles",
      attributes: [
        { definitionId: definitions.get("material")!.id, requirement: "required", sortOrder: 0 },
        { definitionId: definitions.get("item_weight")!.id, requirement: "recommended", sortOrder: 1 },
      ],
      forPkbProductId: pkbProductId,
    });
    expect(family.status).toBe("suggested");
    let [product] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    expect(product).toMatchObject({ familyAssignment: "suggested", familyId: family.id });
    // Not reusable yet: nobody can be assigned to it.
    await expect(assignFamily(owner, pkbProductId, family.id)).rejects.toThrow(/approved family/);

    await expect(approveFamily(marketing, family.id)).rejects.toThrow(AuthorizationError);
    await expect(approveFamily(customer, family.id)).rejects.toThrow(AuthorizationError);
    await approveFamily(productManager, family.id);
    [product] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    expect(product).toMatchObject({ familyAssignment: "assigned", familyId: family.id });

    const view = await getProductKnowledge(harness.db, pkbProductId);
    expect(view!.completeness).toMatchObject({ manual: 1, missingRequired: 1 });
  });

  it("returns a rejected suggestion's products to unassigned", async () => {
    const { pkbProductId } = await knowledgeProduct("Odd Gadget");
    const family = await suggestFamily(productManager, { name: "Odd gadgets", attributes: [], forPkbProductId: pkbProductId });
    await rejectFamily(owner, family.id, "Too narrow");
    const [product] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    expect(product).toMatchObject({ familyAssignment: "unassigned", familyId: null });
  });

  it("evolves a schema by versions without touching stored values", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct("Blender");
    const family = await suggestFamily(owner, {
      name: "Blenders",
      attributes: [{ definitionId: definitions.get("item_weight")!.id, requirement: "required", sortOrder: 0 }],
    });
    await approveFamily(owner, family.id);
    await assignFamily(owner, pkbProductId, family.id);

    const draft = await draftFamilyVersion(owner, family.id, [
      { definitionId: definitions.get("material")!.id, requirement: "recommended", sortOrder: 0 },
    ], "Weight is not what defines a blender.");
    await activateFamilyVersion(owner, draft);

    const versions = await harness.db.select().from(pkbFamilyVersions).where(eq(pkbFamilyVersions.familyId, family.id));
    expect(versions.map((version) => [version.version, version.status]).sort()).toEqual([
      [1, "retired"],
      [2, "active"],
    ]);
    expect((await resolveFamilySchema(harness.db, family.id)).map((entry) => entry.definition.key)).toEqual(["material"]);

    const view = await getProductKnowledge(harness.db, pkbProductId);
    expect(view!.productOnlySlots.map((slot) => slot.definition.key)).toContain("item_weight");
    expect(await harness.db.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId))).toHaveLength(1);

    // An active version is history: its attributes cannot be edited in place.
    await refused(
      `delete from pkb_family_attributes where family_version_id = '${versions.find((v) => v.status === "active")!.id}'`,
      /cannot change; create a new version/,
    );
    await refused(`update pkb_family_versions set status = 'draft' where family_id = '${family.id}'`, /cannot go from/);
  });

  it("refuses a family that would be its own ancestor", async () => {
    const parent = await suggestFamily(owner, { name: "Audio", attributes: [] });
    await approveFamily(owner, parent.id);
    const child = await suggestFamily(owner, { name: "Headphones", attributes: [], parentId: parent.id });
    await refused(`update pkb_families set parent_id = '${child.id}' where id = '${parent.id}'`, /own ancestor/);
    expect((await harness.db.select().from(pkbFamilies)).length).toBe(2);
  });
});

describe("sources, evidence and claims", () => {
  it("records sources provider-agnostically and once per document", async () => {
    const first = await recordSource(productManager, {
      sourceType: "manufacturer_documentation",
      acquisitionMethod: "staff_url",
      origin: "OFFICIAL_MANUFACTURER",
      authorityTier: 1,
      url: "https://Www.Example.com/specs#weight",
    });
    const again = await recordSource(productManager, {
      sourceType: "manufacturer_documentation",
      acquisitionMethod: "staff_url",
      origin: "OFFICIAL_MANUFACTURER",
      url: "https://www.example.com/specs",
    });
    expect(again).toBe(first);
    const [row] = await harness.db.select().from(pkbSources).where(eq(pkbSources.id, first));
    expect(row).toMatchObject({ domain: "example.com", acquisitionMethod: "staff_url", authorityTier: 1 });

    await expect(
      recordSource(productManager, { sourceType: "legacy_import", acquisitionMethod: "legacy_import", origin: "UNKNOWN_LEGACY" }),
    ).rejects.toThrow(/recorded by the system/);
    await expect(
      recordSource(customer, { sourceType: "retailer", acquisitionMethod: "staff_url", origin: "APPROVED_EXTERNAL_SOURCE", url: "https://x.example" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("marks a claim that disagrees with a locked value as a conflict and leaves the value alone", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct();
    const weight = definitions.get("item_weight")!;
    const [fact] = await harness.db.select().from(pkbFacts).where(eq(pkbFacts.definitionId, weight.id));
    await lockFact(owner, fact.id);

    const manufacturer = await recordSource(owner, {
      sourceType: "manufacturer_documentation",
      acquisitionMethod: "staff_upload",
      origin: "OFFICIAL_MANUFACTURER",
      authorityTier: 1,
      title: "Spec sheet PDF",
    });
    const retailer = await recordSource(owner, {
      sourceType: "retailer",
      acquisitionMethod: "staff_url",
      origin: "APPROVED_EXTERNAL_SOURCE",
      authorityTier: 2,
      url: "https://retailer.example/p/1",
    });
    const quote = (sourceId: string, value: string) =>
      recordEvidence(owner, { sourceId, pkbProductId, extractionMethod: "pdf_text", excerpt: `Weight: ${value}`, extractedValue: value });

    const agreeing = await proposeFactClaim(owner, { pkbProductId, definitionId: weight.id, evidenceId: await quote(manufacturer, "0.25 kg"), raw: "0.25 kg" });
    expect(agreeing.status).toBe("SUGGESTED");

    const disagreeing = await proposeFactClaim(owner, { pkbProductId, definitionId: weight.id, evidenceId: await quote(retailer, "270 g"), raw: "270 g" });
    expect(disagreeing.status).toBe("CONFLICT");
    const [firstClaim] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, agreeing.id));
    expect(firstClaim.status).toBe("CONFLICT");

    const [unchanged] = await harness.db.select().from(pkbFacts).where(eq(pkbFacts.id, fact.id));
    expect(unchanged).toMatchObject({ rawValue: "250 g", verificationState: "MANUAL" });
    const view = await getProductKnowledge(harness.db, pkbProductId);
    expect(view!.productOnlySlots.find((slot) => slot.definition.key === "item_weight")!.state).toBe("CONFLICT");
  });

  it("refuses a claim without evidence for the same product", async () => {
    const first = await knowledgeProduct("First");
    const second = await knowledgeProduct("Second");
    const source = await recordSource(owner, { sourceType: "supplier_document", acquisitionMethod: "staff_upload", origin: "SUPPLIER_PROVIDED" });
    const evidence = await recordEvidence(owner, { sourceId: source, pkbProductId: first.pkbProductId, extractionMethod: "manual" });
    await expect(
      proposeFactClaim(owner, { pkbProductId: second.pkbProductId, definitionId: second.definitions.get("material")!.id, evidenceId: evidence, raw: "Steel" }),
    ).rejects.toThrow(/evidence recorded for the same product/);
    await refused(
      `insert into pkb_claims (pkb_product_id, target_kind, definition_id, value_status, raw_value, value_text)
       values ('${first.pkbProductId}', 'fact', '${first.definitions.get("material")!.id}', 'normalized', 'Steel', 'Steel')`,
      /evidence_id/,
    );
  });
});

describe("relationships, aliases and export", () => {
  it("stores relationships once and reads them from both ends", async () => {
    const phone = await knowledgeProduct("Phone 15");
    const phone16 = await knowledgeProduct("Phone 16");
    await addRelationship(owner, { fromProductId: phone16.pkbProductId, toProductId: phone.pkbProductId, kind: "successor_of" });
    await addRelationship(owner, { fromProductId: phone16.pkbProductId, toProductId: phone.pkbProductId, kind: "same_series" });
    await addRelationship(owner, { fromProductId: phone.pkbProductId, toProductId: phone16.pkbProductId, kind: "same_series" });

    const fromOld = await listRelationships(harness.db, phone.pkbProductId);
    expect(fromOld.map((row) => row.label).sort()).toEqual(["Predecessor of", "Same series as"]);
    await expect(
      addRelationship(owner, { fromProductId: phone.pkbProductId, toProductId: phone.pkbProductId, kind: "related_to" }),
    ).rejects.toThrow(/itself/);
  });

  it("approves aliases only with the right permission, and one meaning per approved alias", async () => {
    const first = await knowledgeProduct("WH-1000XM6");
    const second = await knowledgeProduct("WH-1000XM5");
    const alias = await suggestAlias(productManager, { target: { kind: "product", id: first.pkbProductId }, alias: "XM6", aliasKind: "abbreviation" });
    await expect(decideAlias(customer, alias.id, "approved")).rejects.toThrow(AuthorizationError);
    await decideAlias(marketing, alias.id, "approved");

    const clash = await suggestAlias(productManager, { target: { kind: "product", id: second.pkbProductId }, alias: "xm6", aliasKind: "misspelling" });
    await expect(decideAlias(owner, clash.id, "approved")).rejects.toThrow(/already an approved alias/);
  });

  it("offers for export only rights-cleared, decided values", () => {
    expect(exportEligibility({ origin: "OFFICIAL_MANUFACTURER", usageRights: "exportable", verificationState: "VERIFIED" }).eligible).toBe(true);
    expect(exportEligibility({ origin: "PROVIDER_RESTRICTED", usageRights: "exportable", verificationState: "VERIFIED" }).eligible).toBe(false);
    expect(exportEligibility({ origin: "UNKNOWN_LEGACY", usageRights: "unknown", verificationState: "LEGACY" }).reasons).toHaveLength(3);
    expect(exportEligibility({ origin: "MANUAL_ADMIN", usageRights: "display", verificationState: "MANUAL" }).eligible).toBe(false);
  });
});

describe("setting values", () => {
  it("normalizes a value set by hand and refuses customers", async () => {
    const { pkbProductId, definitions } = await knowledgeProduct();
    const row = await setFact(owner, { pkbProductId, definitionId: definitions.get("package_weight")!.id, raw: "1.2 lb" });
    expect(row).toMatchObject({ valueNumber: "544.310844", valueUnit: "g", verificationState: "MANUAL" });
    await expect(setFact(customer, { pkbProductId, definitionId: definitions.get("material")!.id, raw: "Oak" })).rejects.toThrow(AuthorizationError);
    const [count] = await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId));
    expect(Number(count.n)).toBe(2);
  });
});
