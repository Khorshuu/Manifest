/**
 * D-123, stored: a real manufacturer page read through the normal research
 * run, with the optional intelligent reading faked, against a real database.
 * The network is replaced by the fixture pages; nothing leaves the machine.
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  categories,
  pkbAttributeDefinitions,
  pkbAttributeProposals,
  pkbClaims,
  pkbEvidence,
  pkbProducts,
  pkbVerificationPolicies,
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
import { fillWithSeoPulse, loadPulseInput } from "@/lib/seo-pulse";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
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

/** What a model might say about the Revlon page — three true statements and three it made up. */
const REVLON_READING = () => [
  fact({ label: "Gray coverage", value: "100%", excerpt: "Ammonia-free** color delivers 100% gray coverage", meaning: "grey coverage" }),
  fact({ label: "Processing time", value: "25 minutes", excerpt: "Leave it on for 25 minutes total.", kind: "compatibility_use" }),
  fact({ label: "What's in the box", value: "ultra-hydrating cream conditioner", excerpt: "Apply the ultra-hydrating cream conditioner after color application.", kind: "box_content" }),
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
  it("uses the deterministic readers alone when no provider is configured", async () => {
    const listing = await revlonListing();
    const report = await research(listing.pkbProductId!);
    expect(report.documentsRetrieved).toBe(1);
    expect(report.providers).toContainEqual(expect.objectContaining({ provider: "extraction:none", status: "NOT_CONFIGURED" }));

    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    // The selected shade, from the variant picker, as a claim on the system Colour attribute.
    expect(claims.map((claim) => claim.rawValue)).toContain("Black (010)");
    const labels = (await openProposals(listing.pkbProductId!)).map((proposal) => proposal.label).sort();
    expect(labels).toEqual(["Best Seller", "DESCRIPTION", "DETAILS", "HOW TO USE IT"]);
  });

  it("adds only what an intelligent reading can show on the page, with the page as the evidence", async () => {
    const provider = new ScriptedProvider(REVLON_READING);
    setProductExtractionProviderForTesting(provider);
    const listing = await revlonListing();
    const report = await research(listing.pkbProductId!);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].product.variant).toBe("Black");
    expect(provider.calls[0].document.text).toContain("Leave it on for 25 minutes total.");
    expect(report.providers).toContainEqual(
      expect.objectContaining({ provider: "extraction:scripted", status: "OK", message: expect.stringContaining("3 confirmed") }),
    );

    const evidence = await harness.db
      .select()
      .from(pkbEvidence)
      .where(and(eq(pkbEvidence.pkbProductId, listing.pkbProductId!), eq(pkbEvidence.extractionMethod, "ai_assisted")));
    expect(evidence.map((row) => row.extractedLabel).sort()).toEqual(["Gray coverage", "Processing time", "What's in the box"]);
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
    const gray = proposals.find((proposal) => proposal.label === "Gray coverage");
    expect(gray?.suggestion).toEqual({ kind: "product_fact", meaning: "grey coverage", method: "ai_assisted" });
    // What is in the box maps to the existing list attribute directly.
    const box = await harness.db
      .select({ raw: pkbClaims.rawValue })
      .from(pkbClaims)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbClaims.definitionId))
      .where(and(eq(pkbClaims.pkbProductId, listing.pkbProductId!), eq(pkbAttributeDefinitions.key, "box_contents")));
    expect(box.map((row) => row.raw)).toEqual(["ultra-hydrating cream conditioner"]);
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
    const first = await revlonListing();
    await research(first.pkbProductId!);
    const [details] = (await openProposals(first.pkbProductId!)).filter((proposal) => proposal.label === "DETAILS");
    const [badge] = (await openProposals(first.pkbProductId!)).filter((proposal) => proposal.label === "Best Seller");

    // The category asked for nothing, so there was no family: "Add to family" makes it.
    const decided = await decideAttributeProposal(staff, details.id, { action: "add_to_family", label: "Details" });
    expect(decided.status).toBe("added_to_family");
    await decideAttributeProposal(staff, badge.id, { action: "ignore" });
    const [product] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, first.pkbProductId!));
    expect(product.familyId).not.toBeNull();
    const [category] = await harness.db.select().from(categories).where(eq(categories.id, beautyId));
    expect(category.defaultFamilyId).toBe(product.familyId);
    const [definition] = await harness.db.select().from(pkbAttributeDefinitions).where(eq(pkbAttributeDefinitions.id, decided.definitionId!));
    expect(definition.label).toBe("Details");

    // Another shade, another product: the label is placed without asking again.
    const second = await revlonListing("Revlon Colorsilk Hair Color - Soft Black", REVLON_SOFT_BLACK);
    await research(second.pkbProductId!);
    const labels = (await openProposals(second.pkbProductId!)).map((proposal) => proposal.label);
    expect(labels).not.toContain("DETAILS");
    expect(labels).not.toContain("Best Seller");
    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, second.pkbProductId!));
    expect(claims.some((claim) => claim.definitionId === decided.definitionId)).toBe(true);
    expect(claims.map((claim) => claim.rawValue)).toContain("Soft Black (011)");
  });

  it("keeps a product-only fact rather than losing it when the family should not ask for it", async () => {
    const listing = await revlonListing();
    await research(listing.pkbProductId!);
    const [how] = (await openProposals(listing.pkbProductId!)).filter((proposal) => proposal.label === "HOW TO USE IT");
    const decided = await decideAttributeProposal(staff, how.id, { action: "product_only", label: "How to use" });
    expect(decided.status).toBe("product_only");
    const [claim] = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.id, decided.claimId!));
    expect(claim.rawValue).toContain("Everything you need is inside the box!");
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

