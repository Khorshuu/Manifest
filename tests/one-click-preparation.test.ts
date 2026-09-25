/**
 * One-click SeoPulse preparation (D-122).
 *
 * "Prepare with SeoPulse" is one action: research, verification, generation,
 * writing the safe fields into the listing, search and the page check. What is
 * asserted here is that the one action really finishes the listing where it
 * may — and that everything it must not do, it still does not do: replace a
 * person's words, write filler, carry on past a page about another product,
 * or do any piece of work twice.
 *
 * As in product-preparation.test.ts, the enrichment worker is not run: the
 * enrichment run is completed the way the worker would complete it, so nothing
 * here depends on a live website.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbClaims,
  pkbEnrichmentRuns,
  pkbSourceDocuments,
  pkbSources,
  productPreparationRuns,
  productSearchQueue,
  products,
  seoFieldHistory,
  seoResearchRuns,
  users,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, getReadiness, updateProduct } from "@/lib/catalog";
import { provideDocument } from "@/lib/pkb/enrichment";
import { isIdentityLine } from "@/lib/pkb/identity-labels";
import { groundedKnowledge } from "@/lib/pkb/publish";
import {
  advancePreparation,
  continuePreparation,
  PREPARATION_CODES,
  retryPreparation,
  startPreparation,
} from "@/lib/preparation";
import { decisionSummary, preparationOutcome } from "@/lib/preparation/presentation";
import { setProductResearchProviderForTesting } from "@/lib/providers/research";
import { processSearchQueue } from "@/lib/search/maintenance";
import { contentOwnership } from "@/lib/seo/fields";
import { applyPreparedContent, fillWithSeoPulse, seoPulseRecommendations } from "@/lib/seo-pulse/service";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
let categoryId = "";
let keys = 0;

const requestKey = () => `00000000-0000-4000-9000-${String(++keys).padStart(12, "0")}`;
const OFFICIAL = "https://harbor-acoustics.test/hp-900";

beforeAll(async () => {
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

/**
 * A product with enough established fact to write from, and nothing a
 * shopper reads: no description, no key features, no SEO wording.
 */
async function makeKnownListing(extra: Partial<ListingInput> = {}) {
  const product = await createProduct(staff, {
    categoryId,
    title: "HP-900 Headphones",
    brand: "Harbor Acoustics",
    identity: { modelNumber: "HP-900", officialUrl: OFFICIAL },
    specTable: [
      { label: "Driver", value: "40 mm" },
      { label: "Connectivity", value: "Bluetooth 5.4" },
      { label: "Noise cancelling", value: "Active" },
    ],
    measurements: [{ label: "Item weight", value: "250 g" }],
    ...extra,
  } as ListingInput);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return listing;
}

async function runRow(runId: string) {
  const [row] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return row;
}

async function listingRow(productId: string) {
  const [row] = await harness.db.select().from(products).where(eq(products.id, productId));
  return row;
}

type Hook = (enrichmentRunId: string) => Promise<void>;

/** Finishes queued research the way the worker would, or as `hook` says. */
async function completeEnrichmentRuns(hook?: Hook) {
  const queued = await harness.db.select({ id: pkbEnrichmentRuns.id }).from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.status, "queued"));
  for (const run of queued) {
    if (hook) await hook(run.id);
    else {
      await harness.db
        .update(pkbEnrichmentRuns)
        .set({ status: "completed", finishedAt: new Date() })
        .where(eq(pkbEnrichmentRuns.id, run.id));
    }
  }
}

/** Drives the run to its next resting place: finished, or waiting for a person. */
async function drive(runId: string, hook?: Hook, rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    const before = await runRow(runId);
    if (!before || before.finishedAt || before.stage === "NEEDS_REVIEW") break;
    await completeEnrichmentRuns(hook);
    await processSearchQueue();
    await advancePreparation(runId);
  }
  return runRow(runId);
}

async function history(productId: string, field?: string) {
  return harness.db
    .select()
    .from(seoFieldHistory)
    .where(and(eq(seoFieldHistory.productId, productId), field ? eq(seoFieldHistory.field, field as never) : undefined));
}

/** A page read by the research run that turned out to be about another product. */
const mismatchedPage: Hook = async (enrichmentRunId) => {
  const [run] = await harness.db.select().from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.id, enrichmentRunId));
  const [source] = await harness.db.select({ id: pkbSources.id }).from(pkbSources).where(eq(pkbSources.url, OFFICIAL));
  await harness.db.insert(pkbSourceDocuments).values({
    sourceId: source.id,
    pkbProductId: run.pkbProductId,
    runId: enrichmentRunId,
    status: "retrieved",
    textContent: "HP-700 Headphones",
    identityMatch: "mismatch",
    identityNotes: {
      recorded: { name: "HP-900 Headphones", brands: ["Harbor Acoustics"], models: ["HP-900"], gtins: [] },
      found: { names: ["HP-700 Headphones"], brands: ["Harbor Acoustics"], models: ["HP-700"], skus: [], gtins: [] },
    },
  });
  await harness.db
    .update(pkbEnrichmentRuns)
    .set({ status: "completed", documentsRetrieved: 1, finishedAt: new Date() })
    .where(eq(pkbEnrichmentRuns.id, enrichmentRunId));
};

// --------------------------------------------------------- the one action

describe("Prepare with SeoPulse on a new product", () => {
  it("takes the product from Add Product to a written listing in one run, with no Fill", async () => {
    const listing = await makeKnownListing();
    expect(listing.descriptionHtml ?? "").toBe("");

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

    const after = await listingRow(listing.id);
    // Product content: written, about the product, without filler or shop boilerplate.
    expect(after.descriptionHtml).toBeTruthy();
    expect(after.descriptionHtml).toMatch(/Harbor Acoustics|HP-900/);
    expect(after.descriptionHtml).not.toMatch(/is part of our|range\.|delivered across Bangladesh|Buying it here/i);
    const features = after.bulletFeatures as string[];
    expect(features.length).toBeGreaterThan(0);
    expect(features.some(isIdentityLine)).toBe(false);
    // SEO & search: written too.
    expect(after.seoMetaTitle).toBeTruthy();
    expect(after.seoMetaDescription).toBeTruthy();
    expect(after.seoFocusKeyword).toBeTruthy();
    expect((after.tags as string[]).length).toBeGreaterThan(0);
    expect((after.searchKeywords as string[]).length).toBeGreaterThan(0);

    // Through the normal apply path: attributed to SeoPulse, owned by SeoPulse.
    const owners = await contentOwnership(harness.db, listing.id, [
      "descriptionHtml",
      "bulletFeatures",
      "seoMetaTitle",
      "seoMetaDescription",
      "seoFocusKeyword",
    ]);
    expect([...owners.values()].every((owner) => owner === "seo_pulse")).toBe(true);
    const rows = await history(listing.id, "descriptionHtml");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "Prepared with SeoPulse", workflow: "seo_pulse_apply", sourceRunId: run.seoRunId });

    const step = run.steps.find((entry) => entry.key === "listing")!;
    expect(step.fields?.applied).toEqual(
      expect.arrayContaining(["Description", "Key features", "SEO title", "Meta description", "Focus keyword", "Tags", "Search terms"]),
    );
    expect(step.fields?.kept).toEqual([]);

    // Nothing left for anyone to press in the editor.
    const recommendations = await seoPulseRecommendations(staff, listing.id);
    expect(recommendations?.fields ?? []).toEqual([]);
  });

  it("shows the specifications without a separate apply, and keeps identity apart from them", async () => {
    const listing = await makeKnownListing();
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");

    const knowledge = await groundedKnowledge(listing.pkbProductId);
    const labels = knowledge.attributes.map((attribute) => attribute.label.toLowerCase());
    // Established facts reach the editor from the knowledge base; identity is not a specification.
    expect(labels).toContain("item weight");

    const after = await listingRow(listing.id);
    const outcome = preparationOutcome({
      steps: run.steps,
      listing: {
        description: Boolean(after.descriptionHtml),
        keyFeatures: (after.bulletFeatures as string[]).length > 0,
        seoTitle: Boolean(after.seoMetaTitle),
        metaDescription: Boolean(after.seoMetaDescription),
        focusKeyword: Boolean(after.seoFocusKeyword),
      },
      specifications: knowledge.attributes.length,
      decisions: [],
    });
    const items = outcome.flatMap((group) => group.items);
    expect(items.filter((item) => item.state !== "done")).toEqual([]);
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Description prepared", "Key features prepared", "SEO prepared", "Search prepared", "Checked"]),
    );
  });

  it("updates search and checks the page as part of the same run", async () => {
    const listing = await makeKnownListing();
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);

    expect(run.steps.find((step) => step.key === "search")?.detail).toMatch(/search index/i);
    expect(run.steps.find((step) => step.key === "page")?.detail).toMatch(/SEO checks \d+ of \d+/);
    // The listing written by the run was rebuilt into search, not left queued.
    expect(await harness.db.select().from(productSearchQueue).where(eq(productSearchQueue.productId, listing.id))).toHaveLength(0);
  });

  it("is READY for SeoPulse and still not publishable without a photograph and a price", async () => {
    const listing = await makeKnownListing();
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(run.stage).toBe("READY");

    const checks = await getReadiness(staff, listing.id);
    const missing = checks.filter((check) => check.required && !check.passed).map((check) => check.id);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.join(" ")).toMatch(/image|photo/i);
  });
});

// ------------------------------------------------------ whose words are whose

describe("content somebody already wrote", () => {
  it("keeps a staff-written description, and says a SeoPulse version is waiting", async () => {
    const listing = await makeKnownListing({ descriptionHtml: "<p>Our own words about the HP-900.</p>" });
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);

    expect(run.stage).toBe("READY");
    const after = await listingRow(listing.id);
    expect(after.descriptionHtml).toBe("<p>Our own words about the HP-900.</p>");
    expect(run.steps.find((step) => step.key === "listing")?.fields?.kept).toContain("Description");
    // The empty fields beside it were still filled.
    expect(after.seoMetaTitle).toBeTruthy();

    const recommendations = await seoPulseRecommendations(staff, listing.id);
    const waiting = recommendations!.fields.filter((entry) => entry.owner === "staff");
    expect(waiting.map((entry) => entry.field)).toEqual(["descriptionHtml"]);
    expect(decisionSummary(recommendations!.fields)).toBe("1 recommendation needs your decision");
  });

  it("keeps SeoPulse wording that staff edited, when the product is prepared again", async () => {
    const listing = await makeKnownListing();
    await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);

    await updateProduct(staff, listing.id, { descriptionHtml: "<p>Edited by the merchandiser.</p>" });
    // New knowledge, so the next generation genuinely differs.
    await updateProduct(staff, listing.id, {
      specTable: [
        { label: "Driver", value: "40 mm" },
        { label: "Connectivity", value: "Bluetooth 5.4" },
        { label: "Noise cancelling", value: "Active" },
        { label: "Battery life", value: "30 hours" },
      ],
    });

    const again = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(again.stage).toBe("READY");
    expect((await listingRow(listing.id)).descriptionHtml).toBe("<p>Edited by the merchandiser.</p>");
    expect(again.steps.find((step) => step.key === "listing")?.fields?.kept).toContain("Description");
  });

  it("refreshes SeoPulse's own untouched wording when the product is prepared again", async () => {
    const listing = await makeKnownListing();
    const first = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    const before = await listingRow(listing.id);

    await updateProduct(staff, listing.id, {
      specTable: [
        { label: "Driver", value: "40 mm" },
        { label: "Connectivity", value: "Bluetooth 5.4" },
        { label: "Noise cancelling", value: "Active" },
        { label: "Battery life", value: "30 hours" },
      ],
    });

    const again = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(again.id).not.toBe(first.id);
    expect(again.stage).toBe("READY");
    const after = await listingRow(listing.id);
    expect(after.descriptionHtml).not.toBe(before.descriptionHtml);
    expect(after.descriptionHtml).toMatch(/30 hours/);
    expect(again.steps.find((step) => step.key === "listing")?.fields?.refreshed).toContain("Description");

    // The earlier wording is in the history, not lost.
    const rows = await history(listing.id, "descriptionHtml");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reason === "Prepared with SeoPulse")).toBe(true);
  });
});

// --------------------------------------------------------------- stopping

describe("where the one action stops", () => {
  it("stops before generation when the page describes another product, then resumes the same run once corrected", async () => {
    const listing = await makeKnownListing();
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const stopped = await drive(started.id, mismatchedPage);

    expect(stopped.stage).toBe("NEEDS_REVIEW");
    expect(stopped.review.map((note) => note.code)).toContain(PREPARATION_CODES.SOURCE_IDENTITY_MISMATCH);
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(0);
    expect((await listingRow(listing.id)).descriptionHtml ?? "").toBe("");

    // Corrected: the same run carries on from identification.
    const continued = await continuePreparation(staff, started.id, { identity: { modelNumber: "HP-900" } });
    expect(continued.id).toBe(started.id);
    const finished = await drive(started.id);
    expect(finished.id).toBe(started.id);
    expect(finished.stage).toBe("READY");
    expect((await listingRow(listing.id)).descriptionHtml).toBeTruthy();
    expect(await harness.db.select().from(productPreparationRuns)).toHaveLength(1);
  });

  it("stops while researched values wait for a person, and writes no content", async () => {
    const listing = await makeKnownListing();
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await continuePreparation(staff, started.id, {
      document: { title: "HP-900 sheet", content: ["Color: Graphite", "Material: Aluminium"].join("\n") },
    });
    const run = await drive(started.id);

    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((note) => note.code)).toContain(PREPARATION_CODES.CLAIMS_WAITING);
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(0);
    expect((await listingRow(listing.id)).descriptionHtml ?? "").toBe("");
  });

  it("writes no filler when too little is known, and continues the same run once more is added", async () => {
    const product = await createProduct(staff, {
      categoryId,
      title: "HP-900 Headphones",
      brand: "Harbor Acoustics",
      identity: { modelNumber: "HP-900", officialUrl: OFFICIAL },
    } as ListingInput);
    const started = await startPreparation(staff, product.id, { requestKey: requestKey() });
    const thin = await drive(started.id);

    expect(thin.stage).toBe("NEEDS_REVIEW");
    expect(thin.review.map((note) => note.code)).toContain(PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE);
    const empty = await listingRow(product.id);
    expect(empty.descriptionHtml ?? "").toBe("");
    expect(empty.bulletFeatures ?? []).toEqual([]);
    expect(empty.seoMetaTitle ?? "").toBe("");

    // A second page: research runs again, inside the same run.
    await continuePreparation(staff, started.id, { urls: ["https://harbor-acoustics.test/hp-900/specs"] });
    const reread = await drive(started.id);
    expect(reread.id).toBe(started.id);
    expect(await harness.db.select().from(pkbEnrichmentRuns)).toHaveLength(2);
    expect(reread.review.map((note) => note.code)).toContain(PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE);

    // Specifications added by hand, then Continue: the same run writes the listing.
    await updateProduct(staff, product.id, {
      specTable: [
        { label: "Driver", value: "40 mm" },
        { label: "Connectivity", value: "Bluetooth 5.4" },
      ],
      measurements: [{ label: "Item weight", value: "250 g" }],
    });
    await continuePreparation(staff, started.id);
    const ready = await drive(started.id);
    expect(ready.id).toBe(started.id);
    expect(ready.stage).toBe("READY");
    expect((await listingRow(product.id)).descriptionHtml).toBeTruthy();
    expect(await harness.db.select().from(productPreparationRuns)).toHaveLength(1);
  });

  it("keeps the same run while the background service is not picking it up", async () => {
    const listing = await makeKnownListing();
    const key = requestKey();
    const started = await startPreparation(staff, listing.id, { requestKey: key });
    // Nothing advances it: a refresh, a second click and navigation all find it.
    expect((await startPreparation(staff, listing.id, { requestKey: key })).id).toBe(started.id);
    expect((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id).toBe(started.id);
    // When the service returns, it carries on as the same run.
    const run = await drive(started.id);
    expect(run.id).toBe(started.id);
    expect(run.stage).toBe("READY");
  });
});

// ---------------------------------------------------------------- twice

describe("doing it twice", () => {
  it("creates one run from a double click, however the requests race", async () => {
    const listing = await makeKnownListing();
    const key = requestKey();
    const results = await Promise.all([
      startPreparation(staff, listing.id, { requestKey: key }),
      startPreparation(staff, listing.id, { requestKey: key }),
      startPreparation(staff, listing.id, { requestKey: requestKey() }),
    ]);
    expect(new Set(results.map((run) => run.id)).size).toBe(1);
    expect(await harness.db.select().from(productPreparationRuns)).toHaveLength(1);
  });

  it("writes each field once when the listing step is retried", async () => {
    const listing = await makeKnownListing();
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const ready = await drive(started.id);
    const historyBefore = await history(listing.id);
    const generationsBefore = await harness.db.select().from(seoResearchRuns);

    // As if the worker died after writing the listing but before recording it.
    await harness.db
      .update(productPreparationRuns)
      .set({
        steps: ready.steps.filter((step) => !["listing", "search", "page"].includes(step.key)),
        stage: "PREPARING_CONTENT",
        finishedAt: null,
      })
      .where(eq(productPreparationRuns.id, started.id));
    const again = await drive(started.id);

    expect(again.stage).toBe("READY");
    expect(await history(listing.id)).toHaveLength(historyBefore.length);
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(generationsBefore.length);
    expect(again.steps.find((step) => step.key === "listing")?.detail).toMatch(/already holds/);
  });

  it("retries a stopped run without a second research run or a second generation", async () => {
    const listing = await makeKnownListing();
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await drive(started.id);
    await retryPreparation(staff, started.id);
    await continuePreparation(staff, started.id);
    await drive(started.id);
    expect(await harness.db.select().from(pkbEnrichmentRuns)).toHaveLength(1);
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(1);
  });

  it("prepares again as a new run only once the previous one has finished", async () => {
    const listing = await makeKnownListing();
    const first = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    await drive(first.id);
    const second = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const third = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    expect(second.id).not.toBe(first.id);
    expect(third.id).toBe(second.id);
    expect((await runRow(first.id)).stage).toBe("READY");
  });
});

describe("preparing again from a page that has not changed", () => {
  it("does not ask anyone to accept a value they already accepted, and still flags one that changed", async () => {
    const listing = await makeKnownListing();
    const first = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(first.stage).toBe("READY");

    // The page read again says what was already decided: nothing waits.
    await provideDocument(staff, listing.pkbProductId!, { title: "HP-900 sheet", content: "Item weight: 250 g" });
    let claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    expect(claims.map((claim) => claim.status)).toEqual(["SUPERSEDED"]);
    const again = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(again.stage).toBe("READY");

    // A page that now says something else is a question for a person.
    await provideDocument(staff, listing.pkbProductId!, { title: "HP-900 sheet v2", content: "Item weight: 310 g" });
    claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, listing.pkbProductId!));
    expect(claims.map((claim) => claim.status).sort()).toEqual(["CONFLICT", "SUPERSEDED"]);
    const third = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    expect(third.stage).toBe("NEEDS_REVIEW");
    expect(third.review.map((note) => note.code)).toContain(PREPARATION_CODES.CLAIMS_CONFLICT);
  });
});

// ------------------------------------------------------------ the old paths

describe("what stays as it was", () => {
  it("keeps Fill working for the manual path", async () => {
    const listing = await makeKnownListing();
    const result = await fillWithSeoPulse(staff, listing.id);
    expect(result.filled).toEqual(expect.arrayContaining(["Description", "SEO title"]));
  });

  it("asks for the same permission as before, at every new entry point", async () => {
    const listing = await makeKnownListing();
    const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const ready = await drive(started.id);
    await expect(applyPreparedContent(customer, listing.id, ready.seoRunId!)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(startPreparation(customer, listing.id, { requestKey: requestKey() })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(continuePreparation(customer, started.id)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
