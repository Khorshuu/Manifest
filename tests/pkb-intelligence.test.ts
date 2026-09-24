/**
 * Stage 3 of the knowledge platform: product resolution, the reviewed label
 * mapping workflow (A-8), source trust and verification policies (A-9),
 * conflicts, admin approval and its transaction safety, attribute discovery,
 * and identifier history (R-6).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAttributeDefinitions,
  pkbAttributeProposals,
  pkbBrands,
  pkbClaims,
  pkbFacts,
  pkbIdentifierHistory,
  pkbIdentifiers,
  pkbLabelMappings,
  pkbProducts,
  pkbSourceRegistry,
  pkbSources,
  pkbUnmappedValues,
  pkbVerificationPolicies,
  products,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createCategoryAttribute, createProduct, updateProduct } from "@/lib/catalog";
import { PkbError } from "@/lib/pkb/common";
import { decideAttributeProposal, guessShape, proposeAttribute } from "@/lib/pkb/discovery";
import { provideDocument, requestEnrichment } from "@/lib/pkb/enrichment";
import { identityVerdict } from "@/lib/pkb/enrichment";
import { recordEvidence, recordSource } from "@/lib/pkb/evidence";
import { getProductIntelligence, intelligenceQueue } from "@/lib/pkb/intelligence";
import { decideLabelMapping, listUnmappedLabels } from "@/lib/pkb/mappings";
import { assessResolution, confirmIdentity, reassessResolution } from "@/lib/pkb/resolution";
import { acceptClaims, createClaim, rejectClaims, resolveConflict } from "@/lib/pkb/review";
import { processKnowledgeQueue } from "@/lib/pkb/sync";
import { decideRegistryEntry, evaluateVerification, suggestRegistryEntry } from "@/lib/pkb/trust";
import { loadDefinitions } from "@/lib/pkb/vocabulary";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const manager: SessionUser = { id: "", email: "manager@example.com", role: "product_manager" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
/** Staff, and holds seo.view — but not catalog.manage. */
const marketing: SessionUser = { id: "", email: "marketing@example.com", role: "marketing" };

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
      { email: "manager@example.com", passwordHash: "x", role: "product_manager" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
      { email: "marketing@example.com", passwordHash: "x", role: "marketing" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === "staff@example.com")!.id;
  manager.id = rows.find((row) => row.email === "manager@example.com")!.id;
  customer.id = rows.find((row) => row.email === "shopper@example.com")!.id;
  marketing.id = rows.find((row) => row.email === "marketing@example.com")!.id;
});

async function makeListing(input: { title: string; brand?: string; details?: Record<string, string>; specTable?: { label: string; value: string }[] }) {
  const category = await createCategory(staff, { name: "Audio", slug: `audio-${Math.random().toString(36).slice(2, 7)}` });
  const product = await createProduct(staff, {
    title: input.title,
    categoryId: category.id,
    brand: input.brand,
    details: input.details,
    specTable: input.specTable,
  });
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return { categoryId: category.id, listing, pkbProductId: listing.pkbProductId! };
}

/** An approved official-documentation source for a brand, as the registry would. */
async function approveOfficialDomain(brandName: string, domain: string) {
  const [brand] = await harness.db.select().from(pkbBrands).where(eq(pkbBrands.nameNormalized, brandName.toLowerCase()));
  const entry = await suggestRegistryEntry(staff, { brandId: brand?.id ?? null, role: "official_documentation", domain });
  await decideRegistryEntry(manager, entry.id, "approved");
  return entry.id;
}

async function claimFromSource(
  pkbProductId: string,
  input: { definitionKey: string; raw: string; url?: string; sourceType?: "manufacturer_documentation" | "retailer" },
) {
  const sourceId = await recordSource(staff, {
    sourceType: input.sourceType ?? "manufacturer_documentation",
    acquisitionMethod: "staff_url",
    origin: input.sourceType === "retailer" ? "APPROVED_EXTERNAL_SOURCE" : "OFFICIAL_MANUFACTURER",
    url: input.url ?? "https://docs.harbor-acoustics.test/hp-900",
  });
  const evidenceId = await recordEvidence(staff, {
    sourceId,
    pkbProductId,
    extractionMethod: "html_table",
    excerpt: `${input.definitionKey}: ${input.raw}`,
    extractedLabel: input.definitionKey,
    extractedValue: input.raw,
  });
  const [definition] = (await loadDefinitions(harness.db)).filter((row) => row.key === input.definitionKey);
  expect(definition, `definition ${input.definitionKey}`).toBeTruthy();
  return harness.db.transaction(async (tx) =>
    createClaim(tx, {
      pkbProductId,
      pkbVariantId: null,
      evidenceId,
      proposedBy: staff.id,
      proposedByRun: null,
      target: "fact",
      definition,
      raw: input.raw,
    }),
  );
}

describe("product resolution", () => {
  it("is UNRESOLVED without an identifier or a brand, and enrichment is refused", async () => {
    const { pkbProductId } = await makeListing({ title: "Nameless Speaker" });
    const assessment = await assessResolution(harness.db, pkbProductId);
    expect(assessment.state).toBe("UNRESOLVED");

    const run = await requestEnrichment(staff, { pkbProductId });
    expect(run.status).toBe("blocked");
    expect(run.blockedReason).toMatch(/identity is UNRESOLVED/);
  });

  it("reaches HIGH_CONFIDENCE with a brand and a model number, and enrichment is accepted", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      details: { modelNumber: "HP-900" },
    });
    const assessment = await assessResolution(harness.db, pkbProductId);
    expect(assessment.state).toBe("HIGH_CONFIDENCE");

    const run = await requestEnrichment(staff, { pkbProductId });
    expect(run.status).toBe("queued");
    expect(run.blockedReason).toBeNull();
  });

  it("confirming the identity needs a note, and records who decided", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      details: { modelNumber: "HP-900" },
    });
    await expect(confirmIdentity(staff, pkbProductId, { note: "ok" })).rejects.toBeInstanceOf(PkbError);

    await confirmIdentity(staff, pkbProductId, { note: "Matched the model number on the manufacturer's page." });
    const [row] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    expect(row.resolutionState).toBe("VERIFIED");
    expect(row.resolutionDecidedBy).toBe(staff.id);
  });

  it("refuses a customer", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    await expect(requestEnrichment(customer, { pkbProductId })).rejects.toBeInstanceOf(AuthorizationError);
  });

  /*
   * Stage 8. Re-assessing reads like a refresh and writes like a decision: it
   * stores the state, appends a history row, and clears a confirmed identity
   * that no longer holds. The admin screen's button used to reach the
   * executor-level function directly, so any staff account could do all three.
   */
  it("re-assessing is a knowledge write, so a staff account without catalogue access is refused", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      details: { modelNumber: "HP-900" },
    });
    await confirmIdentity(staff, pkbProductId, { note: "Matched the model number on the manufacturer's page." });

    await expect(reassessResolution(marketing, pkbProductId)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(reassessResolution(customer, pkbProductId)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(reassessResolution(null, pkbProductId)).rejects.toBeTruthy();

    // The decision it could have cleared is still there.
    const [untouched] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    expect(untouched.resolutionState).toBe("VERIFIED");
    expect(untouched.resolutionDecidedBy).toBe(staff.id);

    // And somebody who may manage the catalogue still can.
    const assessment = await reassessResolution(manager, pkbProductId);
    expect(assessment.state).toBeTruthy();
  });
});

describe("reviewed label mappings", () => {
  it("places a written label once and remembers the decision for the next listing", async () => {
    const first = await makeListing({
      title: "HP-900 Headphones",
      specTable: [{ label: "Driver diameter", value: "40 mm" }],
    });

    // The label matches no attribute, so it waits for a person.
    const waiting = await listUnmappedLabels(harness.db);
    const group = waiting.find((row) => row.label === "Driver diameter");
    expect(group).toBeTruthy();
    expect(group!.context).toBe("spec_table");

    // An attribute to map it to, defined the ordinary way.
    await createCategoryAttribute(staff, first.categoryId, { name: "Driver size", dataType: "measurement", unit: "mm" } as never);
    const definitions = await loadDefinitions(harness.db);
    const target = definitions.find((row) => row.label === "Driver size")!;

    // Only a knowledge manager decides.
    await expect(
      decideLabelMapping(customer, { label: "Driver diameter", context: "spec_table", action: "map", definitionId: target.id }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const decision = await decideLabelMapping(manager, {
      label: "Driver diameter",
      context: "spec_table",
      action: "map",
      definitionId: target.id,
      note: "Same measurement, written differently by the supplier.",
    });
    expect(decision.listingsQueued).toBe(1);

    await processKnowledgeQueue(harness.db, { limit: 10 });
    const placed = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, first.pkbProductId), eq(pkbFacts.definitionId, target.id)));
    expect(placed).toHaveLength(1);
    expect(placed[0].rawLabel).toBe("Driver diameter");
    expect(placed[0].rawValue).toBe("40 mm");

    // The queue entry for it is gone, and a second listing is placed with no
    // further decision.
    const remaining = await listUnmappedLabels(harness.db);
    expect(remaining.find((row) => row.label === "Driver diameter")).toBeUndefined();

    const second = await createProduct(staff, {
      title: "HP-700 Headphones",
      categoryId: first.categoryId,
      specTable: [{ label: "Driver diameter", value: "32 mm" }],
    });
    const [secondListing] = await harness.db.select().from(products).where(eq(products.id, second.id));
    const secondFacts = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, secondListing.pkbProductId!), eq(pkbFacts.definitionId, target.id)));
    expect(secondFacts).toHaveLength(1);
    expect(secondFacts[0].rawValue).toBe("32 mm");
  });

  it("stops reporting a label that a person marked as not an attribute", async () => {
    const first = await makeListing({
      title: "HP-900 Headphones",
      specTable: [{ label: "Marketing tagline", value: "Hear everything" }],
    });
    await decideLabelMapping(manager, { label: "Marketing tagline", context: "spec_table", action: "ignore" });
    await processKnowledgeQueue(harness.db, { limit: 10 });

    const open = await harness.db
      .select()
      .from(pkbUnmappedValues)
      .where(and(eq(pkbUnmappedValues.productId, first.listing.id), eq(pkbUnmappedValues.status, "open")));
    expect(open.map((row) => row.label)).not.toContain("Marketing tagline");
    const mappings = await harness.db.select().from(pkbLabelMappings);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].action).toBe("ignore");
  });
});

describe("source trust and verification policies", () => {
  it("does not verify a value from a domain nobody approved", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics", details: { material: "Aluminium" } });
    const claim = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });

    const qualification = await evaluateVerification(harness.db, claim.id);
    expect(qualification.eligible).toBe(false);

    await expect(acceptClaims(staff, { claimIds: [claim.id], asVerified: true })).rejects.toBeInstanceOf(PkbError);

    const result = await acceptClaims(staff, { claimIds: [claim.id] });
    expect(result).toMatchObject({ accepted: 1, verified: 0 });
    const [fact] = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, pkbProductId), eq(pkbFacts.rawValue, "Graphite")));
    expect(fact.verificationState).toBe("UNVERIFIED");
  });

  it("verifies the same value once the brand's documentation domain is approved", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics", details: { material: "Aluminium" } });
    await approveOfficialDomain("harbor acoustics", "docs.harbor-acoustics.test");

    const claim = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    const qualification = await evaluateVerification(harness.db, claim.id);
    expect(qualification.eligible).toBe(true);
    expect(qualification.policy?.key).toBe("official_manufacturer_documentation");

    const result = await acceptClaims(staff, { claimIds: [claim.id], asVerified: true });
    expect(result).toMatchObject({ accepted: 1, verified: 1 });
    const [fact] = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, pkbProductId), eq(pkbFacts.rawValue, "Graphite")));
    expect(fact.verificationState).toBe("VERIFIED");
  });

  it("stops verifying under a policy that has been turned off", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    await approveOfficialDomain("harbor acoustics", "docs.harbor-acoustics.test");
    await harness.db
      .update(pkbVerificationPolicies)
      .set({ status: "retired" })
      .where(eq(pkbVerificationPolicies.key, "official_manufacturer_documentation"));

    const claim = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    expect((await evaluateVerification(harness.db, claim.id)).eligible).toBe(false);
  });

  it("keeps a registry entry powerless until someone approves it", async () => {
    const entry = await suggestRegistryEntry(staff, { brandId: null, role: "official_documentation", domain: "docs.example.test" });
    const [row] = await harness.db.select().from(pkbSourceRegistry).where(eq(pkbSourceRegistry.id, entry.id));
    expect(row.status).toBe("suggested");
    expect(row.decidedAt).toBeNull();
    await expect(decideRegistryEntry(customer, entry.id, "approved")).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("conflicts and approval", () => {
  it("marks disagreeing claims as CONFLICT and refuses to accept one directly", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    const first = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    const second = await claimFromSource(pkbProductId, {
      definitionKey: "color",
      raw: "Charcoal",
      url: "https://shop.example.test/hp-900",
      sourceType: "retailer",
    });

    expect(second.status).toBe("CONFLICT");
    const [reloaded] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, first.id));
    expect(reloaded.status).toBe("CONFLICT");

    await expect(acceptClaims(staff, { claimIds: [second.id] })).rejects.toBeInstanceOf(PkbError);

    await resolveConflict(staff, { claimId: first.id, note: "The manufacturer's page wins." });
    const [fact] = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, pkbProductId), eq(pkbFacts.definitionId, first.definitionId!)));
    expect(fact.rawValue).toBe("Graphite");
    const [rejected] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, second.id));
    expect(rejected.status).toBe("REJECTED");
  });

  it("applies the named claims only, all or nothing", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    const keep = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    const other = await claimFromSource(pkbProductId, { definitionKey: "material", raw: "Aluminium" });

    // Two claims for one slot in a single action is refused, and nothing is written.
    const duplicate = await claimFromSource(pkbProductId, { definitionKey: "material", raw: "Aluminium" });
    await expect(acceptClaims(staff, { claimIds: [other.id, duplicate.id] })).rejects.toBeInstanceOf(PkbError);
    const fromClaims = async () =>
      (await harness.db.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId))).filter(
        (row) => row.definitionId === keep.definitionId || row.definitionId === other.definitionId,
      );
    expect(await fromClaims()).toHaveLength(0);

    await acceptClaims(staff, { claimIds: [keep.id] });
    expect((await fromClaims()).map((row) => row.rawValue)).toEqual(["Graphite"]);

    expect(await rejectClaims(staff, [other.id])).toBe(1);
  });

  it("refuses a customer every way in", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    const claim = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    await expect(acceptClaims(customer, { claimIds: [claim.id] })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(rejectClaims(customer, [claim.id])).rejects.toBeInstanceOf(AuthorizationError);
    await expect(getProductIntelligence(customer, pkbProductId)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("attribute discovery", () => {
  it("guesses a shape without deciding anything", () => {
    expect(guessShape("40 mm", null)).toMatchObject({ dataType: "quantity", unitDimension: "length" });
    expect(guessShape("Yes", null)).toMatchObject({ dataType: "boolean" });
    expect(guessShape("A soft carry case", null)).toMatchObject({ dataType: "text" });
  });

  it("defines a product-only attribute, remembers the label and proposes the value", async () => {
    const { pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    const sourceId = await recordSource(staff, {
      sourceType: "manufacturer_documentation",
      acquisitionMethod: "staff_url",
      origin: "OFFICIAL_MANUFACTURER",
      url: "https://docs.harbor-acoustics.test/hp-900",
    });
    const evidenceId = await recordEvidence(staff, {
      sourceId,
      pkbProductId,
      extractionMethod: "html_table",
      excerpt: "Cable length: 1.2 m",
      extractedLabel: "Cable length",
      extractedValue: "1.2 m",
    });

    const proposal = await harness.db.transaction((tx) =>
      proposeAttribute(tx, { pkbProductId, label: "Cable length", exampleValue: "1.2 m", evidenceId }),
    );
    expect(proposal.created).toBe(true);

    // Proposing twice folds into the open proposal.
    const again = await harness.db.transaction((tx) =>
      proposeAttribute(tx, { pkbProductId, label: "cable  length", exampleValue: "1.2 m", evidenceId }),
    );
    expect(again).toMatchObject({ created: false, proposalId: proposal.proposalId });

    await expect(decideAttributeProposal(customer, proposal.proposalId, { action: "product_only" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const decided = await decideAttributeProposal(manager, proposal.proposalId, { action: "product_only" });
    expect(decided.status).toBe("product_only");
    expect(decided.claimId).toBeTruthy();
    expect(decided.versionId).toBeNull();

    const [definition] = await harness.db
      .select()
      .from(pkbAttributeDefinitions)
      .where(eq(pkbAttributeDefinitions.id, decided.definitionId!));
    expect(definition).toMatchObject({ label: "Cable length", dataType: "quantity", status: "approved", origin: "MANUAL_ADMIN" });

    const [mapping] = await harness.db.select().from(pkbLabelMappings);
    expect(mapping).toMatchObject({ action: "map", definitionId: decided.definitionId, context: "source_document" });

    // The value is a claim, not a fact: it still goes through review.
    const [claim] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, decided.claimId!));
    expect(claim.status).toBe("SUGGESTED");
    expect(await harness.db.select().from(pkbFacts).where(eq(pkbFacts.definitionId, decided.definitionId!))).toHaveLength(0);

    const [row] = await harness.db
      .select()
      .from(pkbAttributeProposals)
      .where(eq(pkbAttributeProposals.id, proposal.proposalId));
    expect(row).toMatchObject({ status: "product_only", decidedBy: manager.id });
  });

  it("refuses Add to Family for a family that mirrors a category, pointing at the category", async () => {
    const { categoryId, listing, pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    // The category gains a specification, so a family mirrors it; the listing
    // is assigned to that family on its next sync.
    await createCategoryAttribute(staff, categoryId, { name: "Driver size", dataType: "measurement", unit: "mm" } as never);
    await processKnowledgeQueue(harness.db, { limit: 10 });
    expect(listing.id).toBeTruthy();

    const sourceId = await recordSource(staff, {
      sourceType: "manufacturer_documentation",
      acquisitionMethod: "staff_url",
      origin: "OFFICIAL_MANUFACTURER",
      url: "https://docs.harbor-acoustics.test/hp-900",
    });
    const evidenceId = await recordEvidence(staff, {
      sourceId,
      pkbProductId,
      extractionMethod: "html_table",
      excerpt: "Cable length: 1.2 m",
      extractedLabel: "Cable length",
      extractedValue: "1.2 m",
    });
    const proposal = await harness.db.transaction((tx) =>
      proposeAttribute(tx, { pkbProductId, label: "Cable length", exampleValue: "1.2 m", evidenceId }),
    );

    const decided = await decideAttributeProposal(manager, proposal.proposalId, { action: "add_to_family" });
    expect(decided.status).toBe("added_to_family");
    // The category gained the specification, and the family mirrors it.
    const definitions = await loadDefinitions(harness.db);
    expect(definitions.find((row) => row.id === decided.definitionId)?.label).toBe("Cable length");
  });
});

describe("identifiers", () => {
  it("keeps an auditable history and never corrects a check digit", async () => {
    const { listing, pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    await updateProduct(staff, listing.id, { identifierType: "gtin", identifierValue: "4006381333931" });

    const [identifier] = await harness.db.select().from(pkbIdentifiers).where(eq(pkbIdentifiers.pkbProductId, pkbProductId));
    expect(identifier).toMatchObject({ validationStatus: "valid" });

    await updateProduct(staff, listing.id, { identifierType: "gtin", identifierValue: "5012345678900" });
    const history = await harness.db
      .select()
      .from(pkbIdentifierHistory)
      .where(eq(pkbIdentifierHistory.pkbProductId, pkbProductId))
      .orderBy(pkbIdentifierHistory.createdAt);
    expect(history.map((row) => row.changeKind)).toEqual(["created", "updated"]);
    expect(history[1].before).toMatchObject({ valueRaw: "4006381333931" });
    expect(history[1].after).toMatchObject({ valueRaw: "5012345678900" });
    expect(history[1].actorUserId).toBe(staff.id);
    expect(history[1].reason).toBeTruthy();
  });

  it("keeps an invalid identifier as supplied, marked invalid", async () => {
    const { listing, pkbProductId } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics" });
    await updateProduct(staff, listing.id, { identifierType: "gtin", identifierValue: "4006381333932" });

    const identifiers = await harness.db.select().from(pkbIdentifiers).where(eq(pkbIdentifiers.pkbProductId, pkbProductId));
    const waiting = await harness.db
      .select()
      .from(pkbUnmappedValues)
      .where(and(eq(pkbUnmappedValues.productId, listing.id), eq(pkbUnmappedValues.reason, "invalid_identifier")));

    // Either it is stored as invalid, or it waits for a person — never
    // silently corrected to a valid check digit.
    const stored = identifiers.map((row) => row.valueRaw);
    expect([...stored, ...waiting.map((row) => row.value)]).toContain("4006381333932");
    expect(stored).not.toContain("4006381333931");
  });
});

describe("documents a person provides", () => {
  it("records evidence, proposes what it recognises and queues the rest", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      details: { modelNumber: "HP-900", material: "Aluminium" },
    });

    const outcome = await provideDocument(staff, pkbProductId, {
      title: "HP-900 specification sheet",
      content: ["Color: Graphite", "Cable length: 1.2 m", "Marketing tagline: Hear everything"].join("\n"),
    });

    expect(outcome.claimsProposed).toBeGreaterThanOrEqual(1);
    expect(outcome.proposalsCreated).toBeGreaterThanOrEqual(1);

    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId));
    expect(claims.every((claim) => claim.status === "SUGGESTED" || claim.status === "CONFLICT")).toBe(true);
    expect(await harness.db.select().from(pkbFacts).where(eq(pkbFacts.rawValue, "Graphite"))).toHaveLength(0);

    const sources = await harness.db.select().from(pkbSources).where(eq(pkbSources.acquisitionMethod, "staff_upload"));
    expect(sources).toHaveLength(1);

    const view = await getProductIntelligence(staff, pkbProductId);
    expect(view!.documents).toHaveLength(1);
    expect(view!.proposals.length).toBeGreaterThanOrEqual(1);

    const queue = await intelligenceQueue(staff);
    expect(queue.find((row) => row.pkbProductId === pkbProductId)).toBeTruthy();
  });
});

describe("identity gating", () => {
  const base = {
    pkbProductId: "00000000-0000-0000-0000-000000000001",
    name: "HP-900",
    brands: [{ id: "b", name: "Harbor Acoustics", key: "harbor acoustics" }],
    modelName: null,
    generation: null,
    modelKeys: ["HP900"],
    gtins: [{ gtin14: "04006381333931", pkbVariantId: null }],
  };
  const extraction = (identity: Partial<{ names: string[]; brands: string[]; gtins: string[]; mpns: string[]; models: string[] }>) => ({
    pairs: [],
    identity: { names: [], brands: [], gtins: [], mpns: [], models: [], ...identity },
    structuredData: [],
    text: "",
  });

  it("agrees when a GTIN matches", () => {
    expect(identityVerdict(base, extraction({ gtins: ["4006381333931"] })).match).toBe("match");
  });

  it("disagrees when the document carries a different GTIN", () => {
    expect(identityVerdict(base, extraction({ gtins: ["5012345678900"] })).match).toBe("mismatch");
  });

  it("disagrees when the model number belongs to another generation", () => {
    const noGtin = { ...base, gtins: [] };
    expect(identityVerdict(noGtin, extraction({ mpns: ["HP-950"] })).match).toBe("mismatch");
    expect(identityVerdict(noGtin, extraction({ mpns: ["hp 900"] })).match).toBe("match");
  });

  it("says unknown rather than guessing when the document names nothing recognisable", () => {
    const noGtin = { ...base, gtins: [] };
    expect(identityVerdict(noGtin, extraction({})).match).toBe("unknown");
  });
});

describe("the knowledge queue", () => {
  it("counts what is waiting per product", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900",
      brand: "Harbor Acoustics",
      specTable: [{ label: "Driver diameter", value: "40 mm" }],
    });
    const claim = await claimFromSource(pkbProductId, { definitionKey: "color", raw: "Graphite" });
    expect(claim.status).toBe("SUGGESTED");

    const queue = await intelligenceQueue(staff);
    const row = queue.find((entry) => entry.pkbProductId === pkbProductId);
    expect(row).toMatchObject({ openClaims: 1 });
    expect(row!.unmappedRows).toBeGreaterThanOrEqual(1);

    const counted = Number(
      (await harness.db.select({ n: sql<number>`count(*)::int` }).from(pkbUnmappedValues).where(eq(pkbUnmappedValues.status, "open")))[0].n,
    );
    expect(counted).toBeGreaterThanOrEqual(1);
  });
});
