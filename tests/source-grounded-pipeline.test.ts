/**
 * D-123, stored: a real manufacturer page read through the normal research
 * run, with the optional intelligent reading faked, against a real database.
 * The network is replaced by the fixture pages; nothing leaves the machine.
 */
import { readFileSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  categories,
  pkbAttributeDefinitions,
  pkbAttributeProposals,
  pkbClaims,
  pkbEnrichmentRuns,
  pkbEvidence,
  pkbIdentifiers,
  pkbProducts,
  pkbSources,
  pkbVerificationPolicies,
  productPreparationRuns,
  products,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createCategoryAttribute, createProduct, updateProduct } from "@/lib/catalog";
import { decideAttributeProposal } from "@/lib/pkb/discovery";
import { provideDocument, requestEnrichment, runEnrichment } from "@/lib/pkb/enrichment";
import { assessResolution } from "@/lib/pkb/resolution";
import { acceptClaims } from "@/lib/pkb/review";
import { decideRegistryEntry, evaluateVerification, setPolicyStatus, suggestRegistryEntry, trustedBrandIds } from "@/lib/pkb/trust";
import {
  setProductExtractionProviderForTesting,
  type DocumentExtractionRequest,
  type ExtractionCandidate,
  type ProductDocumentExtractionProvider,
} from "@/lib/providers/extraction";
import { applyPreparedContent, applySeoPulse, fillWithSeoPulse, loadPulseInput, runSeoPulse } from "@/lib/seo-pulse";
import { identityCleanup, reclassifyWeakIdentity } from "@/lib/catalog/identity-cleanup";
import { groundedKnowledge } from "@/lib/pkb/publish";
import { contentOwnership } from "@/lib/seo/fields";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { advancePreparation, continuePreparation, startPreparation } from "@/lib/preparation";
import { createTestDatabase } from "./helpers/database";

const PAGES: Record<string, string> = {
  "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451": readFileSync(
    "tests/fixtures/revlon-colorsilk.html",
    "utf8",
  ),
  "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44109262717123": readFileSync(
    "tests/fixtures/revlon-colorsilk.html",
    "utf8",
  )
    // The same page showing Soft Black, as the shop renders that address.
    .replace(/(data-option-index="0">\s*)Black\s*\(010\)/, "$1Soft Black (011)")
    .replace('"sku":"0309970185015","brand"', '"sku":"0309970185022","brand"')
    .replace(
      '"url":"https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451","price"',
      '"url":"https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44109262717123","price"',
    ),
};

vi.mock("@/lib/pkb/net/robots", () => ({
  checkRobots: async () => ({ allowed: true, reason: "allowed" }),
}));
vi.mock("@/lib/pkb/net/safe-fetch", async (original) => {
  const actual = await original<typeof import("@/lib/pkb/net/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string) =>
      PAGES[url]
        ? { ok: true, url, status: 200, contentType: "text/html", charset: "utf-8", body: Buffer.from(PAGES[url]), redirects: [] }
        : { ok: false, code: "HTTP_STATUS", reason: "not found", status: 404, url },
  };
});

const REVLON_BLACK = "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451";
const REVLON_SOFT_BLACK = "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44109262717123";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let beautyId = "";
let seq = 0;

/** A provider that answers from a script and records what it was asked. */
class ScriptedProvider implements ProductDocumentExtractionProvider {
  readonly key = "scripted";
  calls: DocumentExtractionRequest[] = [];
  constructor(private readonly answer: (request: DocumentExtractionRequest) => ExtractionCandidate[]) {}
  async extract(request: DocumentExtractionRequest) {
    this.calls.push(request);
    return { status: "OK" as const, candidates: this.answer(request), model: "scripted", inputTokens: null, outputTokens: null };
  }
}

const fact = (candidate: Partial<ExtractionCandidate> & Pick<ExtractionCandidate, "label" | "value" | "excerpt">): ExtractionCandidate => ({
  unit: null,
  section: null,
  meaning: null,
  kind: "product_fact",
  ...candidate,
});

/** What a model might say about the Revlon page — seven true statements (one already read) and three it made up. */
const REVLON_READING = () => [
  fact({ label: "Gray coverage", value: "100%", excerpt: "Ammonia-free** color delivers 100% gray coverage", meaning: "grey coverage" }),
  fact({ label: "Processing time", value: "25 minutes", excerpt: "Leave it on for 25 minutes total.", kind: "compatibility_use" }),
  fact({ label: "What's in the box", value: "ultra-hydrating cream conditioner", excerpt: "Apply the ultra-hydrating cream conditioner after color application.", kind: "box_content" }),
  fact({ label: "Formulation", value: "bond Repair Complex + Vegan Keratin Fillers", excerpt: "New + improved with bond Repair Complex + Vegan Keratin Fillers to help repair hair from the inside out." }),
  fact({ label: "What's in the box", value: "coloring gloves", excerpt: "Put on coloring gloves and pour the ammonia-free colorant into the cream developer bottle.", kind: "box_content" }),
  fact({ label: "What's in the box", value: "cream developer bottle", excerpt: "pour the ammonia-free colorant into the cream developer bottle", kind: "box_content" }),
  // Already read from the page's structure: not read a second time.
  fact({ label: "Color", value: "Black (010)", excerpt: "Black (010)", kind: "variant_fact" }),
  fact({ label: "Color duration", value: "up to 12 weeks", excerpt: "up to 8 weeks of vibrant, salon-quality color and shine" }),
  fact({ label: "Certification", value: "Dermatologist tested", excerpt: "Dermatologist tested for sensitive scalps." }),
  fact({ label: "Formulation", value: "paraben-free", excerpt: "Ammonia-free** color delivers 100% gray coverage" }),
];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/unused";
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
  beautyId = (await createCategory(staff, { name: "Beauty & Care", slug: `beauty-${++seq}` })).id;
});

afterEach(() => setProductExtractionProviderForTesting(undefined));

type ListingInput = Parameters<typeof createProduct>[1];

async function revlonListing(title = "Revlon Colorsilk Hair Color - Black", url = REVLON_BLACK) {
  const product = await createProduct(staff, {
    categoryId: beautyId,
    title,
    brand: "Revlon",
    identity: { modelName: "Shade 10", modelNumber: "(1N)", mpn: "10", officialUrl: url },
  } as ListingInput);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return listing;
}

async function research(pkbProductId: string) {
  const requested = await requestEnrichment(staff, { pkbProductId, requestKey: `test-${++seq}` });
  return runEnrichment(requested.runId);
}

const openProposals = (pkbProductId: string) =>
  harness.db
    .select()
    .from(pkbAttributeProposals)
    .where(and(eq(pkbAttributeProposals.pkbProductId, pkbProductId), eq(pkbAttributeProposals.status, "open")));

describe("identity for a product sold by shade", () => {
  it("is settled by brand, exact name and shade — and says the typed codes are not identifiers", async () => {
    const listing = await revlonListing();
    const assessment = await assessResolution(harness.db, listing.pkbProductId!);
    expect(assessment.state).toBe("HIGH_CONFIDENCE");
    expect(assessment.reasons.map((reason) => reason.code)).toEqual(["identified_by_name", "weak_identifier"]);
    expect(assessment.reasons[1].message).toContain('"(1N)"');
  });

  it("is not settled by a short code and a vague name", async () => {
    const product = await createProduct(staff, {
      categoryId: beautyId,
      title: "Revlon Dye",
      brand: "Revlon",
      identity: { mpn: "10" },
    } as ListingInput);
    const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
    const assessment = await assessResolution(harness.db, listing.pkbProductId!);
    expect(assessment.state).toBe("UNRESOLVED");
    expect(assessment.reasons[0].code).toBe("weak_identifier");
  });
});

describe("reading the real Revlon page through a research run", () => {
  it("uses the deterministic readers alone when no provider is configured, and says what it could not read", async () => {
    const listing = await revlonListing();
    const report = await research(listing.pkbProductId!);
    expect(report.documentsRetrieved).toBe(1);
    const extraction = report.providers.find((provider) => provider.provider === "extraction:none");
    expect(extraction?.status).toBe("NOT_CONFIGURED");
    // The prose sections are named as unread, not passed off as facts.
    expect(extraction?.message).toMatch(/3 sections of prose on this page \(DESCRIPTION, DETAILS, HOW TO USE IT\) were not read into facts/);

    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    // The selected shade, from the variant picker, as a claim on the system Colour attribute.
    expect(claims.map((claim) => claim.rawValue)).toContain("Black (010)");
    // A page section's heading is never offered as an attribute.
    const labels = (await openProposals(listing.pkbProductId!)).map((proposal) => proposal.label).sort();
    expect(labels).toEqual(["Best Seller"]);
  });

  it("gives the reader every sentence of a long section and turns one section into several grounded facts", async () => {
    const provider = new ScriptedProvider(REVLON_READING);
    setProductExtractionProviderForTesting(provider);
    const listing = await revlonListing();
    const report = await research(listing.pkbProductId!);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].product.variant).toBe("Black");
    const text = provider.calls[0].document.text;
    // The DETAILS section runs past 400 characters; its last statement is still there.
    expect(text).toContain("Ammonia-free** color delivers 100% gray coverage and up to 8 weeks");
    expect(text).toContain("Leave it on for 25 minutes total.");
    expect(report.providers).toContainEqual(
      expect.objectContaining({ provider: "extraction:scripted", status: "OK", message: expect.stringContaining("7 confirmed") }),
    );

    const evidence = await harness.db
      .select()
      .from(pkbEvidence)
      .where(and(eq(pkbEvidence.pkbProductId, listing.pkbProductId!), eq(pkbEvidence.extractionMethod, "ai_assisted")));
    expect(evidence.map((row) => row.extractedLabel).sort()).toEqual([
      "Formulation",
      "Gray coverage",
      "Processing time",
      "What's in the box",
      "What's in the box",
      "What's in the box",
    ]);
    const page = PAGES[REVLON_BLACK];
    for (const row of evidence) {
      // The stored excerpt is the page's text, not the model's.
      expect(page.replace(/\s+/g, " ")).toContain(row.excerpt!.replace(/\s+/g, " "));
    }
    // Made-up figures, certifications and ingredients never reach the knowledge base.
    const stored = JSON.stringify(await harness.db.select().from(pkbEvidence).where(eq(pkbEvidence.pkbProductId, listing.pkbProductId!)));
    expect(stored).not.toContain("12 weeks");
    expect(stored).not.toContain("Dermatologist tested");
    expect(stored).not.toContain("paraben");

    // New concepts become proposals a person decides, with what the reading suggested.
    const proposals = await openProposals(listing.pkbProductId!);
    expect(proposals.map((proposal) => proposal.label).sort()).toEqual(["Best Seller", "Formulation", "Gray coverage", "Processing time"]);
    const gray = proposals.find((proposal) => proposal.label === "Gray coverage");
    expect(gray?.suggestion).toEqual({ kind: "product_fact", meaning: "grey coverage", method: "ai_assisted" });
    // What is in the box maps to the existing list attribute, one item per statement, in order.
    const box = await harness.db
      .select({ raw: pkbClaims.rawValue, ordinal: pkbClaims.ordinal })
      .from(pkbClaims)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbClaims.definitionId))
      .where(and(eq(pkbClaims.pkbProductId, listing.pkbProductId!), eq(pkbAttributeDefinitions.key, "box_contents")));
    expect(box.sort((a, b) => a.ordinal - b.ordinal).map((row) => row.raw)).toEqual([
      "ultra-hydrating cream conditioner",
      "coloring gloves",
      "cream developer bottle",
    ]);
    // The structured reading of the shade is not read a second time.
    const colour = await harness.db
      .select({ raw: pkbClaims.rawValue })
      .from(pkbClaims)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbClaims.definitionId))
      .where(and(eq(pkbClaims.pkbProductId, listing.pkbProductId!), eq(pkbAttributeDefinitions.key, "color")));
    expect(colour).toHaveLength(1);
  });

  it("does not use the selected shade of a page showing a different shade", async () => {
    const listing = await revlonListing("Revlon Colorsilk Hair Color - Soft Black", REVLON_BLACK);
    await research(listing.pkbProductId!);
    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    expect(claims.map((claim) => claim.rawValue)).not.toContain("Black (010)");
  });

  it("asks the provider nothing when the structured readers already found enough", async () => {
    const provider = new ScriptedProvider(() => []);
    setProductExtractionProviderForTesting(provider);
    const listing = await revlonListing();
    await provideDocument(staff, listing.pkbProductId!, {
      title: "Specification sheet",
      content: ["Colour: Black", "Net contents: 1 kit", "Developer: 60 ml", "Colorant: 59 ml", "Conditioner: 5.9 ml", "Gloves: 1 pair", "Ammonia: none"].join("\n"),
    });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("learning a kind of product's vocabulary once", () => {
  it("creates the family on the first decision and reuses it for the next product of that kind", async () => {
    setProductExtractionProviderForTesting(new ScriptedProvider(REVLON_READING));
    const first = await revlonListing();
    await research(first.pkbProductId!);
    const open = await openProposals(first.pkbProductId!);
    const gray = open.find((proposal) => proposal.label === "Gray coverage")!;
    const badge = open.find((proposal) => proposal.label === "Best Seller")!;

    // The category asked for nothing, so there was no family: "Add to family" makes it.
    const decided = await decideAttributeProposal(staff, gray.id, { action: "add_to_family" });
    expect(decided.status).toBe("added_to_family");
    await decideAttributeProposal(staff, badge.id, { action: "ignore" });
    const [product] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, first.pkbProductId!));
    expect(product.familyId).not.toBeNull();
    const [category] = await harness.db.select().from(categories).where(eq(categories.id, beautyId));
    expect(category.defaultFamilyId).toBe(product.familyId);
    const [definition] = await harness.db.select().from(pkbAttributeDefinitions).where(eq(pkbAttributeDefinitions.id, decided.definitionId!));
    expect(definition.label).toBe("Gray coverage");
    // No section heading became part of the family.
    const families = await harness.db.select({ label: pkbAttributeDefinitions.label }).from(pkbAttributeDefinitions);
    expect(families.map((row) => row.label)).not.toEqual(expect.arrayContaining(["DETAILS"]));
    expect(families.map((row) => row.label.toLowerCase())).not.toContain("how to use it");

    // Another shade, another product: the label is placed without asking again.
    const second = await revlonListing("Revlon Colorsilk Hair Color - Soft Black", REVLON_SOFT_BLACK);
    await research(second.pkbProductId!);
    const labels = (await openProposals(second.pkbProductId!)).map((proposal) => proposal.label);
    expect(labels).not.toContain("Gray coverage");
    expect(labels).not.toContain("Best Seller");
    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, second.pkbProductId!));
    expect(claims.some((claim) => claim.definitionId === decided.definitionId && claim.rawValue === "100%")).toBe(true);
    expect(claims.map((claim) => claim.rawValue)).toContain("Soft Black (011)");
  });

  it("keeps a product-only fact rather than losing it when the family should not ask for it", async () => {
    setProductExtractionProviderForTesting(new ScriptedProvider(REVLON_READING));
    const listing = await revlonListing();
    await research(listing.pkbProductId!);
    const time = (await openProposals(listing.pkbProductId!)).find((proposal) => proposal.label === "Processing time")!;
    const decided = await decideAttributeProposal(staff, time.id, { action: "product_only" });
    expect(decided.status).toBe("product_only");
    const [claim] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, decided.claimId!));
    expect(claim.rawValue).toBe("25 minutes");
  });
});

describe("verifying what an intelligent reading found", () => {
  it("needs the owner's opt-in policy on top of the approved official domain", async () => {
    setProductExtractionProviderForTesting(new ScriptedProvider(REVLON_READING));
    const listing = await revlonListing();
    const [brandId] = await trustedBrandIds(harness.db, listing.pkbProductId!);
    const entry = await suggestRegistryEntry(staff, { brandId, role: "official_product", domain: "revlon.com" });
    await decideRegistryEntry(staff, entry.id, "approved");
    await research(listing.pkbProductId!);

    const rows = await harness.db
      .select({ id: pkbClaims.id, method: pkbEvidence.extractionMethod, raw: pkbClaims.rawValue })
      .from(pkbClaims)
      .innerJoin(pkbEvidence, eq(pkbEvidence.id, pkbClaims.evidenceId))
      .where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    const structured = rows.find((row) => row.method !== "ai_assisted" && row.raw === "Black (010)")!;
    const assisted = rows.find((row) => row.method === "ai_assisted")!;
    expect((await evaluateVerification(harness.db, structured.id)).eligible).toBe(true);
    expect((await evaluateVerification(harness.db, assisted.id)).eligible).toBe(false);

    const [policy] = await harness.db
      .select()
      .from(pkbVerificationPolicies)
      .where(eq(pkbVerificationPolicies.key, "official_manufacturer_documentation_ai_read"));
    expect(policy.status).toBe("draft");
    await setPolicyStatus(staff, policy.id, "active");
    expect((await evaluateVerification(harness.db, assisted.id)).eligible).toBe(true);
    await acceptClaims(staff, { claimIds: [assisted.id], asVerified: true });
  });
});

describe("SEO while research is incomplete", () => {
  it("fills no SEO title or meta description and leaves a person's wording alone", async () => {
    const listing = await revlonListing();
    await updateProduct(staff, listing.id, { seoMetaDescription: "Written by staff: Revlon ColorSilk, shade Black." });
    const input = await loadPulseInput(listing.id);
    expect(knowledgeSufficiency(input!).sufficient).toBe(false);

    const result = await fillWithSeoPulse(staff, listing.id);
    expect(result.needsKnowledge).not.toBeNull();
    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(after.seoMetaTitle).toBeNull();
    expect(after.seoMetaDescription).toBe("Written by staff: Revlon ColorSilk, shade Black.");
    expect(after.descriptionHtml ?? "").toBe("");
  });
});

describe("a non-electronics product, judged by its own family", () => {
  it("is read, mapped and judged by the family's schema with no measurement asked for", async () => {
    const skincare = await createCategory(staff, { name: "Skincare", slug: `skincare-${++seq}` });
    await createCategoryAttribute(staff, skincare.id, { name: "Skin type", dataType: "text", isRequired: true } as never);
    await createCategoryAttribute(staff, skincare.id, { name: "Ingredients", dataType: "text" } as never);
    const product = await createProduct(staff, {
      categoryId: skincare.id,
      title: "Northfield Botanics Daily Barrier Cream 50 ml",
      brand: "Northfield Botanics",
    } as ListingInput);
    const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));

    const before = knowledgeSufficiency((await loadPulseInput(listing.id))!);
    expect(before.family?.requiredMissing).toEqual(["Skin type"]);
    expect(before.missing.join(" ")).not.toMatch(/measurement/i);

    await provideDocument(staff, listing.pkbProductId!, {
      title: "Northfield Botanics product page",
      content: readFileSync("tests/fixtures/northfield-barrier-cream.html", "utf8"),
      contentType: "text/html",
    });
    const claims = await harness.db
      .select({ id: pkbClaims.id, key: pkbAttributeDefinitions.key, raw: pkbClaims.rawValue, status: pkbClaims.status })
      .from(pkbClaims)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbClaims.definitionId))
      .where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    const open = claims.filter((claim) => claim.status === "SUGGESTED");
    expect(open.map((claim) => claim.raw)).toEqual(expect.arrayContaining(["Dry, sensitive", "50 ml"]));
    await acceptClaims(staff, { claimIds: open.map((claim) => claim.id), asVerified: true });

    const after = knowledgeSufficiency((await loadPulseInput(listing.id))!);
    expect(after.family?.requiredMissing).toEqual([]);
    expect(after.facts).toBeGreaterThanOrEqual(3);
    expect(after.sufficient).toBe(true);
  });
});


// ------------------------------------------------ the D-123 correctness pass

async function approveRevlon(pkbProductId: string) {
  const [brandId] = await trustedBrandIds(harness.db, pkbProductId);
  const entry = await suggestRegistryEntry(staff, { brandId, role: "official_product", domain: "revlon.com" });
  await decideRegistryEntry(staff, entry.id, "approved");
}

async function claimFor(pkbProductId: string, raw: string) {
  const [claim] = await harness.db
    .select()
    .from(pkbClaims)
    .where(and(eq(pkbClaims.pkbProductId, pkbProductId), eq(pkbClaims.rawValue, raw)));
  return claim;
}

describe("a trust decision taking effect on a page already read", () => {
  it("reclassifies the same bytes as the manufacturer's page once its domain is approved", async () => {
    const listing = await revlonListing();
    await research(listing.pkbProductId!);
    const shade = await claimFor(listing.pkbProductId!, "Black (010)");
    expect((await evaluateVerification(harness.db, shade.id)).eligible).toBe(false);

    await approveRevlon(listing.pkbProductId!);
    // The identical page read again: no new bytes, no new source row.
    await research(listing.pkbProductId!);
    const rows = await harness.db
      .select()
      .from(pkbSources)
      .where(and(eq(pkbSources.domain, "revlon.com"), isNotNull(pkbSources.contentSha256)));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe("manufacturer_website");
    // How it was found is history, and stays true.
    expect(rows[0].acquisitionMethod).toBe("staff_url");
    // The value read before the decision now qualifies under the official-source policy.
    const qualification = await evaluateVerification(harness.db, shade.id);
    expect(qualification.eligible).toBe(true);
    expect(qualification.policy?.key).toBe("official_manufacturer_documentation");
  });
});

describe("weak identity, reclassified by a person", () => {
  it("is offered only once the version is established, and clears only the weak values", async () => {
    const listing = await revlonListing();
    expect(await identityCleanup(listing.id)).toBeNull();

    await approveRevlon(listing.pkbProductId!);
    await research(listing.pkbProductId!);
    await acceptClaims(staff, { claimIds: [(await claimFor(listing.pkbProductId!, "Black (010)")).id], asVerified: true });

    const cleanup = await identityCleanup(listing.id);
    expect(cleanup?.established).toEqual([{ label: "Colour", value: "Black (010)" }]);
    expect(cleanup?.issues).toEqual([
      { field: "modelName", label: "Model", value: "Shade 10", equivalent: "Colour: Black (010)" },
      { field: "modelNumber", label: "Model number", value: "(1N)", equivalent: null },
      { field: "manufacturerPartNumber", label: "Manufacturer part number", value: "10", equivalent: "Colour: Black (010)" },
    ]);

    const result = await reclassifyWeakIdentity(staff, listing.id, cleanup!.issues.map((issue) => issue.field));
    expect(result.cleared).toHaveLength(3);
    expect(result.resolution).toBe("HIGH_CONFIDENCE");

    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    const details = (after.details ?? {}) as Record<string, unknown>;
    expect(details.modelName).toBeUndefined();
    expect(details.modelNumber).toBeUndefined();
    expect(details.manufacturerPartNumber).toBeUndefined();
    // The established shade stays.
    const knowledge = await groundedKnowledge(listing.pkbProductId);
    expect(knowledge.attributes.find((attribute) => attribute.key === "color")?.value).toBe("Black (010)");
    expect(knowledge.attributes.some((attribute) => attribute.key === "model_name")).toBe(false);
    const identifiers = await harness.db.select().from(pkbIdentifiers).where(eq(pkbIdentifiers.pkbProductId, listing.pkbProductId!));
    expect(identifiers.filter((row) => row.identifierType === "mpn" || row.identifierType === "model_number")).toEqual([]);
    // Still identified, now by name and shade alone, and nothing weak left to report.
    const assessment = await assessResolution(harness.db, listing.pkbProductId!);
    expect(assessment.reasons.map((reason) => reason.code)).toEqual(["identified_by_name"]);
    expect(await identityCleanup(listing.id)).toBeNull();
    // The decision is on record with what was removed and why.
    const [audit] = await harness.db.select().from(auditLog).where(eq(auditLog.action, "product.identity_reclassified"));
    expect(audit.beforeJson).toEqual({ identity: { modelName: "Shade 10", modelNumber: "(1N)", manufacturerPartNumber: "10" } });
  });

  it("leaves a real manufacturer code alone", async () => {
    const product = await createProduct(staff, {
      categoryId: beautyId,
      title: "Glorious Model O Classic Wireless",
      brand: "Glorious",
      identity: { modelNumber: "GLO-OC-WL-BLK", mpn: "GLO-OC-WL-BLK" },
      details: { color: "Matte Black" },
    } as ListingInput);
    expect(await identityCleanup(product.id)).toBeNull();
    await expect(reclassifyWeakIdentity(staff, product.id, ["modelNumber"])).rejects.toThrow(/nothing to reclassify/i);
  });

  it("refuses a customer and an anonymous caller before looking at the product", async () => {
    const listing = await revlonListing();
    const customer: SessionUser = { id: staff.id, email: "shopper@example.com", role: "customer" };
    await expect(reclassifyWeakIdentity(customer, listing.id, ["modelNumber"])).rejects.toThrow(/only staff/i);
    await expect(reclassifyWeakIdentity(null, listing.id, ["modelNumber"])).rejects.toThrow(/sign in/i);
    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(((after.details ?? {}) as Record<string, unknown>).modelNumber).toBe("(1N)");
  });
});

describe("SeoPulse's own lists", () => {
  async function researched() {
    const product = await createProduct(staff, {
      categoryId: beautyId,
      title: "Revlon Colorsilk Hair Color - Black",
      brand: "Revlon",
      specTable: [
        { label: "Shade", value: "Black (010)" },
        { label: "Gray coverage", value: "100%" },
        { label: "Processing time", value: "25 minutes" },
      ],
    } as ListingInput);
    const { run } = await runSeoPulse(staff, product.id, { requestKey: `lists-${++seq}`, fresh: true });
    return { id: product.id, runId: run.id, generated: run.analysis!.searchAliases };
  }

  it("replaces its own stale terms with the current ones", async () => {
    const { id, runId, generated } = await researched();
    await applySeoPulse(staff, id, { runId, fields: { searchKeywords: ["revlon colorsilk", "10", "1n"] }, overwrite: [] });
    expect((await contentOwnership(harness.db, id, ["searchKeywords"] as const)).get("searchKeywords")).toBe("seo_pulse");

    const result = await applyPreparedContent(staff, id, runId);
    expect(result.refreshed).toContain("Search terms");
    const [row] = await harness.db.select().from(products).where(eq(products.id, id));
    const terms = row.searchKeywords as string[];
    expect(terms).not.toContain("10");
    expect(terms).not.toContain("1n");
    expect(terms).toEqual(expect.arrayContaining(generated.slice(0, 3)));
  });

  it("replaces its own stale terms through Manual fill too, even before the product is researched", async () => {
    const listing = await revlonListing();
    const { run } = await runSeoPulse(staff, listing.id, { requestKey: `fill-${++seq}`, fresh: true });
    await applySeoPulse(staff, listing.id, { runId: run.id, fields: { searchKeywords: ["revlon colorsilk", "10", "1n"] }, overwrite: [] });

    const result = await fillWithSeoPulse(staff, listing.id);
    expect(result.needsKnowledge).not.toBeNull();
    const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    const terms = row.searchKeywords as string[];
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).not.toContain("10");
    expect(terms).not.toContain("1n");
    expect(terms).not.toContain("shade 10");
  });

  it("never removes a term from a list staff wrote", async () => {
    const { id, runId } = await researched();
    await updateProduct(staff, id, { searchKeywords: ["revlon colorsilk", "10"] });
    expect((await contentOwnership(harness.db, id, ["searchKeywords"] as const)).get("searchKeywords")).toBe("staff");

    await applyPreparedContent(staff, id, runId);
    const [row] = await harness.db.select().from(products).where(eq(products.id, id));
    expect(row.searchKeywords).toEqual(["revlon colorsilk", "10"]);
  });
});

describe("preparation when the facts are in prose nobody read", () => {
  it("says intelligent extraction is not configured instead of inventing a specification", async () => {
    const listing = await revlonListing();
    const started = await startPreparation(staff, listing.id, { requestKey: `prep-${++seq}` });
    const drive = async (runId: string) => {
      for (let round = 0; round < 12; round += 1) {
        const [row] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
        if (row.finishedAt || row.stage === "NEEDS_REVIEW") return row;
        for (const queued of await harness.db.select({ id: pkbEnrichmentRuns.id }).from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.status, "queued"))) {
          await runEnrichment(queued.id);
        }
        await advancePreparation(runId);
      }
      throw new Error("did not settle");
    };
    const first = await drive(started.id);
    expect(first.stage).toBe("NEEDS_REVIEW");
    // A person settles what was found: the shade accepted, the badge ignored.
    await acceptClaims(staff, { claimIds: [(await claimFor(listing.pkbProductId!, "Black (010)")).id] });
    const badge = (await openProposals(listing.pkbProductId!)).find((proposal) => proposal.label === "Best Seller")!;
    await decideAttributeProposal(staff, badge.id, { action: "ignore" });
    await continuePreparation(staff, started.id);
    const second = await drive(started.id);
    expect(second.stage).toBe("NEEDS_REVIEW");
    const note = second.review.find((entry) => entry.code === "INSUFFICIENT_KNOWLEDGE");
    expect(note?.message).toContain("intelligent document extraction is not configured");
    // No specification was made out of a section heading.
    const definitions = await harness.db.select({ label: pkbAttributeDefinitions.label }).from(pkbAttributeDefinitions);
    expect(definitions.map((row) => row.label)).not.toEqual(expect.arrayContaining(["DETAILS"]));
  });
});
