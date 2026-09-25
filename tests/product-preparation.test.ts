/**
 * Product preparation (D-112 to D-115).
 *
 * What is asserted here is mostly what preparation *refuses* to do. It is the
 * one place in the system where a single staff action reaches the knowledge
 * base, the research pipeline, the review queue and the content generator at
 * once, so the interesting cases are the ones where it stops: an ambiguous
 * identity, a claim nobody has accepted, a product nothing is known about.
 *
 * The enrichment worker is not run here. Retrieval goes over the network, and
 * a test that depends on a manufacturer's website is a test that fails when
 * that website changes. Instead the enrichment run is completed the way the
 * worker would complete it, which is exactly what preparation is waiting for.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbClaims,
  pkbEnrichmentRuns,
  pkbEvidence,
  pkbFacts,
  pkbIdentifiers,
  pkbProductSources,
  pkbProducts,
  productPreparationRuns,
  products,
  seoResearchRuns,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { ValidationError } from "@/lib/errors";
import { provideDocument, sourceOutlook } from "@/lib/pkb/enrichment";
import {
  advancePreparation,
  cancelPreparation,
  getPreparation,
  retryPreparation,
  startPreparation,
} from "@/lib/preparation";
import { setProductResearchProviderForTesting } from "@/lib/providers/research";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { loadPulseInput } from "@/lib/seo-pulse/service";
import { processSearchQueue } from "@/lib/search/maintenance";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
let categoryId = "";
let keys = 0;

const requestKey = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;

beforeAll(async () => {
  // The provider getter reads the validated environment; these two have no
  // default and nothing else in this file needs them.
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/unused";
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setProductResearchProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setProductResearchProviderForTesting(undefined);
  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === "staff@example.com")!.id;
  customer.id = rows.find((row) => row.email === "shopper@example.com")!.id;
  const category = await createCategory(staff, { name: "Audio", slug: `audio-${++keys}` });
  categoryId = category.id;
});

type ListingInput = Parameters<typeof createProduct>[1];

async function makeListing(input: Partial<ListingInput> & { title: string }) {
  const product = await createProduct(staff, { categoryId, ...input } as ListingInput);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return { listing, pkbProductId: listing.pkbProductId };
}

async function runRow(runId: string) {
  const [row] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return row;
}

/** Finishes any queued enrichment run the way the worker would, without the network. */
async function completeEnrichmentRuns() {
  await harness.db
    .update(pkbEnrichmentRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(pkbEnrichmentRuns.status, "queued"));
}

/** Drives the run to its next resting place: finished, or waiting for a person. */
async function drive(runId: string, rounds = 15) {
  for (let round = 0; round < rounds; round += 1) {
    const before = await runRow(runId);
    if (!before || before.finishedAt || before.stage === "NEEDS_REVIEW") break;
    await completeEnrichmentRuns();
    await processSearchQueue();
    await advancePreparation(runId);
  }
  return runRow(runId);
}

// ------------------------------------------------------- identity, on the save

describe("identity entered on a product save", () => {
  it("resolves the product without anyone opening Product Intelligence", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });

    const [knowledge] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId!));
    expect(knowledge.resolutionState).toBe("HIGH_CONFIDENCE");
    expect(knowledge.resolutionCheckedAt).toBeTruthy();
  });

  it("re-assesses when identity is added later, and again when it is taken away", async () => {
    const { listing, pkbProductId } = await makeListing({ title: "Nameless Speaker" });
    const initial = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId!));
    expect(initial[0].resolutionState).toBe("UNRESOLVED");

    await updateProduct(staff, listing.id, {
      brand: "Harbor Acoustics",
      identity: { gtin: "4006381333931" },
    });
    const [resolved] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId!));
    expect(resolved.resolutionState).toBe("HIGH_CONFIDENCE");

    const [identifier] = await harness.db.select().from(pkbIdentifiers).where(eq(pkbIdentifiers.pkbProductId, pkbProductId!));
    expect(identifier).toMatchObject({ identifierType: "gtin13", validationStatus: "valid" });

    await updateProduct(staff, listing.id, { identity: { gtin: null } });
    const [cleared] = await harness.db.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId!));
    expect(cleared.resolutionState).toBe("UNRESOLVED");
  });

  it("refuses an identifier whose check digit does not hold, and two of them at once", async () => {
    await expect(
      makeListing({ title: "Bad number", brand: "Harbor Acoustics", identity: { gtin: "4006381333932" } }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      makeListing({
        title: "Two numbers",
        brand: "Harbor Acoustics",
        identity: { gtin: "4006381333931", upc: "012345678905" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("records an official address as a source, and nothing else", async () => {
    const { pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
    });

    const sources = await harness.db
      .select()
      .from(pkbProductSources)
      .where(eq(pkbProductSources.pkbProductId, pkbProductId!));
    expect(sources).toHaveLength(1);

    // A page nobody has read is not knowledge: no claim, no evidence, no fact
    // about it, and it has not been trusted.
    expect(await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId!))).toHaveLength(0);
    expect(await harness.db.select().from(pkbEvidence).where(eq(pkbEvidence.pkbProductId, pkbProductId!))).toHaveLength(0);
  });
});

// ------------------------------------------------------------- the run itself

describe("a preparation run", () => {
  it("is blocked when there is not enough to say which product it is", async () => {
    const { listing } = await makeListing({ title: "Nameless Speaker" });
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("BLOCKED");
    expect(run.failure?.code).toBe("IDENTITY_UNRESOLVED");
    expect(run.failure?.remedy).toMatch(/brand/i);
    // Nothing was researched on the strength of not knowing what it is.
    expect(await harness.db.select().from(pkbEnrichmentRuns)).toHaveLength(0);
  });

  it("stops for a person when two products share a brand and a model number", async () => {
    await makeListing({ title: "HP-900 Headphones", brand: "Harbor Acoustics", identity: { modelNumber: "HP-900" } });
    const second = await makeListing({
      title: "HP-900 Headphones (2026)",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });

    const started = await startPreparation(staff, second.listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toContain("IDENTITY_AMBIGUOUS");
    expect(await harness.db.select().from(pkbEnrichmentRuns)).toHaveLength(0);
  });

  it("says plainly that automatic discovery is not configured, rather than reporting no sources", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });

    const outlook = await sourceOutlook(pkbProductId!);
    expect(outlook.provider?.status).toBe("NOT_CONFIGURED");

    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("BLOCKED");
    expect(run.failure?.code).toBe("AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED");
    expect(run.providers[0]).toMatchObject({ provider: "none", status: "NOT_CONFIGURED" });
  });

  it("carries on when staff supplied an address, and again when they supplied a document", async () => {
    const withUrl = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
    });
    const urlRun = await startPreparation(staff, withUrl.listing.id, { requestKey: requestKey() });
    const afterUrl = await drive(urlRun.id);
    expect(afterUrl.steps.find((step) => step.key === "sources")?.detail).toMatch(/1 source/);
    expect(afterUrl.stage).not.toBe("BLOCKED");

    const withDocument = await makeListing({
      title: "HP-800 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-800" },
    });
    await provideDocument(staff, withDocument.pkbProductId!, {
      title: "HP-800 specification sheet",
      content: ["Color: Graphite", "Material: Aluminium"].join("\n"),
    });
    const documentRun = await startPreparation(staff, withDocument.listing.id, { requestKey: requestKey() });
    const afterDocument = await drive(documentRun.id);
    expect(afterDocument.steps.some((step) => step.key === "sources")).toBe(true);
    expect(afterDocument.stage).not.toBe("BLOCKED");
  });

  it("waits for a person when the research proposed values nobody has accepted", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });
    await provideDocument(staff, pkbProductId!, {
      title: "HP-900 specification sheet",
      content: ["Color: Graphite", "Material: Aluminium"].join("\n"),
    });

    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toEqual(
      expect.arrayContaining(["CLAIMS_WAITING"]),
    );

    // Still claims, never facts: reaching a finished run is not worth
    // accepting a value nobody read.
    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId!));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.status === "SUGGESTED" || claim.status === "CONFLICT")).toBe(true);
    expect(await harness.db.select().from(pkbFacts).where(eq(pkbFacts.rawValue, "Graphite"))).toHaveLength(0);
  });

  it("reports too little established knowledge instead of a listing it could not write", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
    });

    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toContain("INSUFFICIENT_KNOWLEDGE");
    expect(run.review[0].message).toMatch(/too little/i);

    // And nothing was written to the listing or to the knowledge base on the
    // strength of a description it could not ground.
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(0);
    const facts = await harness.db.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId!));
    expect(facts.every((fact) => fact.verificationState !== "VERIFIED")).toBe(true);
  });

  it("reaches READY for a product staff filled in, and generates without writing a fact", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
      bulletFeatures: ["Active noise cancelling", "Thirty-hour battery"],
      boxContents: ["Headphones", "Carry case", "USB-C cable"],
      specTable: [
        { label: "Driver", value: "40 mm" },
        { label: "Connectivity", value: "Bluetooth 5.4" },
      ],
      measurements: [{ label: "Item weight", value: "250 g" }],
    });

    const factsBefore = await harness.db
      .select({ total: sql<number>`count(*)::int` })
      .from(pkbFacts)
      .where(eq(pkbFacts.pkbProductId, pkbProductId!));

    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("READY");
    expect(run.steps.map((step) => step.key)).toEqual([
      "identity",
      "sources",
      "enrichment",
      "verification",
      "content",
      "listing",
      "search",
      "page",
    ]);
    expect(run.seoRunId).toBeTruthy();

    // The generator ran and wrote nothing into the knowledge base: prose is
    // not evidence (I-1).
    const [analysis] = await harness.db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, run.seoRunId!));
    expect(analysis.status).toBe("completed");
    const factsAfter = await harness.db
      .select({ total: sql<number>`count(*)::int` })
      .from(pkbFacts)
      .where(eq(pkbFacts.pkbProductId, pkbProductId!));
    expect(Number(factsAfter[0].total)).toBe(Number(factsBefore[0].total));
  });
});

// ------------------------------------------------------------- doing it twice

describe("running it again", () => {
  it("returns the same run for the same request, and for a run already live", async () => {
    const { listing } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
    });
    const key = requestKey();
    const first = await startPreparation(staff, listing.id, { requestKey: key });
    const again = await startPreparation(staff, listing.id, { requestKey: key });
    const another = await startPreparation(staff, listing.id, { requestKey: requestKey() });

    expect(again.id).toBe(first.id);
    expect(another.id).toBe(first.id);
    expect(await harness.db.select().from(productPreparationRuns)).toHaveLength(1);
  });

  it("retries without researching twice or proposing the same value twice", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });
    await provideDocument(staff, pkbProductId!, {
      title: "HP-900 specification sheet",
      content: ["Color: Graphite", "Material: Aluminium"].join("\n"),
    });

    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await drive(started.id);

    const claimsBefore = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId!));
    const evidenceBefore = await harness.db.select().from(pkbEvidence).where(eq(pkbEvidence.pkbProductId, pkbProductId!));
    const enrichmentBefore = await harness.db.select().from(pkbEnrichmentRuns);

    await retryPreparation(staff, started.id);
    await drive(started.id);

    expect(await harness.db.select().from(pkbEnrichmentRuns)).toHaveLength(enrichmentBefore.length);
    expect(await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId!))).toHaveLength(
      claimsBefore.length,
    );
    expect(await harness.db.select().from(pkbEvidence).where(eq(pkbEvidence.pkbProductId, pkbProductId!))).toHaveLength(
      evidenceBefore.length,
    );
  });

  it("stops when it is cancelled, and leaves the product alone", async () => {
    const { listing } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await cancelPreparation(staff, started.id);
    const run = await drive(started.id);

    expect(run.stage).toBe("CANCELLED");
    const [product] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(product.title).toBe("HP-900 Headphones");
  });
});

// ------------------------------------------------------- providers and limits

describe("when a research provider misbehaves", () => {
  it("records the failure and leaves the product untouched", async () => {
    setProductResearchProviderForTesting({
      key: "broken",
      findSources: async () => ({ status: "FAILED", message: "the service answered 500" }),
    });

    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    expect(run.stage).toBe("BLOCKED");
    expect(run.failure?.code).toBe("AUTOMATIC_SOURCE_DISCOVERY_UNAVAILABLE");
    expect(await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId!))).toHaveLength(0);
    expect(await harness.db.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId!))).not.toHaveLength(0);
  });
});

describe("permissions", () => {
  it("refuses a customer at every entry point", async () => {
    const { listing } = await makeListing({ title: "HP-900", brand: "Harbor Acoustics", identity: { modelNumber: "HP-900" } });
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });

    await expect(startPreparation(customer, listing.id, { requestKey: requestKey() })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(getPreparation(customer, listing.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(retryPreparation(customer, started.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(cancelPreparation(customer, started.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(startPreparation(null, listing.id, { requestKey: requestKey() })).rejects.toBeTruthy();
  });
});

// ------------------------------------------------ knowledge reaching SEO Pulse

describe("what the content generator is given", () => {
  it("receives established knowledge and not a claim waiting for review", async () => {
    const { listing, pkbProductId } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
      details: { material: "Aluminium" },
    });
    await provideDocument(staff, pkbProductId!, {
      title: "HP-900 specification sheet",
      content: "Color: Graphite",
    });

    const input = await loadPulseInput(listing.id);
    const values = input!.knowledge.attributes.map((attribute) => attribute.value);

    // Entered by staff, so MANUAL, so published to the generator.
    expect(values).toContain("Aluminium");
    // Proposed by a source and not yet accepted, so absent.
    expect(values).not.toContain("Graphite");
    expect(input!.knowledge.attributes.every((attribute) => attribute.state === "MANUAL" || attribute.state === "VERIFIED")).toBe(true);
  });

  it("counts a bare listing as too thin to write from, and a filled one as enough", async () => {
    const bare = await makeListing({ title: "Mystery Box" });
    expect(knowledgeSufficiency((await loadPulseInput(bare.listing.id))!).sufficient).toBe(false);

    const filled = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
      bulletFeatures: ["Active noise cancelling"],
      boxContents: ["Headphones", "Carry case"],
      specTable: [{ label: "Driver", value: "40 mm" }],
      measurements: [{ label: "Item weight", value: "250 g" }],
    });
    expect(knowledgeSufficiency((await loadPulseInput(filled.listing.id))!).sufficient).toBe(true);
  });
});

describe("a preparation run's own record", () => {
  it("keeps no stack trace and no raw error in what it reports", async () => {
    const { listing } = await makeListing({ title: "Nameless Speaker" });
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const run = await drive(started.id);

    const text = JSON.stringify({ failure: run.failure, review: run.review, steps: run.steps });
    expect(text).not.toMatch(/\bat \w+ \(/);
    expect(text).not.toMatch(/Error:/);
    expect(run.failure?.message.length).toBeGreaterThan(0);
    expect(run.failure?.remedy.length).toBeGreaterThan(0);
  });

  it("only ever has one live run per product", async () => {
    const { listing } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900" },
    });
    await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await startPreparation(staff, listing.id, { requestKey: requestKey() });

    const live = await harness.db
      .select()
      .from(productPreparationRuns)
      .where(and(eq(productPreparationRuns.productId, listing.id), sql`finished_at is null`));
    expect(live).toHaveLength(1);
  });
});

/*
 * The staff editor's Product identity panel (D-116).
 *
 * The panel sends the manufacturer's model fields as an `identity` block
 * rather than as `details`, which is what lets it share a product with the
 * specifications panel without either one erasing the other. That is a
 * property of `identityColumns` rather than of the screen, so it is asserted
 * here: if it ever stopped holding, a staff member saving a model number
 * would silently wipe the weight and the dimensions.
 */
describe("the identity panel's save shape", () => {
  it("folds model fields into details without disturbing the rest of them", async () => {
    const { listing } = await makeListing({
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      details: { itemWeight: "250 g", packageDimensions: "20 x 18 x 8 cm" },
    });

    await updateProduct(staff, listing.id, {
      identity: { modelName: "HP-900", modelNumber: "HP-900B", mpn: "HA-HP900-BLK" },
    });

    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    const details = after.details as Record<string, string>;
    expect(details.modelName).toBe("HP-900");
    expect(details.modelNumber).toBe("HP-900B");
    expect(details.manufacturerPartNumber).toBe("HA-HP900-BLK");
    // Untouched by a save that never mentioned them.
    expect(details.itemWeight).toBe("250 g");
    expect(details.packageDimensions).toBe("20 x 18 x 8 cm");
  });

  it("accepts a part number alongside the listing's own trade identifier", async () => {
    const { listing } = await makeListing({ title: "HP-900 Headphones", brand: "Harbor Acoustics" });

    await updateProduct(staff, listing.id, {
      identifierType: "gtin",
      identifierValue: "4006381333931",
      identity: { modelNumber: "HP-900", mpn: "HA-HP900-BLK" },
    });

    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(after.identifierType).toBe("gtin");
    expect(after.identifierValue).toBe("4006381333931");
    expect((after.details as Record<string, string>).manufacturerPartNumber).toBe("HA-HP900-BLK");
  });
});
