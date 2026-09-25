/**
 * The stored side of the Glorious Model O diagnostic (D-119): what a failed
 * source write costs, what Fill with SeoPulse may write when too little is
 * known, and what preparation tells a person when a page could not be stored
 * or describes a different product. Against a real database; nothing here
 * reaches the network.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  jobs,
  pkbEnrichmentRuns,
  pkbSourceDocuments,
  pkbSources,
  productPreparationRuns,
  products,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { enqueueJob, runDueJobs } from "@/lib/jobs/runner";
import {
  advancePreparation,
  productResearchStatus,
  PREPARATION_CODES,
  startPreparation,
} from "@/lib/preparation";
import { processSearchQueue } from "@/lib/search/maintenance";
import { fillWithSeoPulse } from "@/lib/seo-pulse";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let keys = 0;
const requestKey = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;

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
  const category = await createCategory(staff, { name: "Electronics", slug: `electronics-${++keys}` });
  categoryId = category.id;
});

type ListingInput = Parameters<typeof createProduct>[1];

async function makeListing(input: Partial<ListingInput> = {}) {
  const product = await createProduct(staff, {
    categoryId,
    title: "Glorious Model O",
    brand: "Glorious",
    identity: {
      modelNumber: "GO-WHITE",
      mpn: "GO-WHITE",
      officialUrl: "https://www.gloriousgaming.com/products/model-o-classic-wireless-mouse",
    },
    ...input,
  } as ListingInput);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return listing;
}

async function runRow(runId: string) {
  const [row] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return row;
}

/** Drives a preparation run, finishing each research run the way `finish` says. */
async function drive(runId: string, finish: (enrichmentRunId: string) => Promise<void>) {
  for (let round = 0; round < 15; round += 1) {
    const before = await runRow(runId);
    if (!before || before.finishedAt || before.stage === "NEEDS_REVIEW") break;
    for (const queued of await harness.db
      .select({ id: pkbEnrichmentRuns.id })
      .from(pkbEnrichmentRuns)
      .where(eq(pkbEnrichmentRuns.status, "queued"))) {
      await finish(queued.id);
    }
    await processSearchQueue();
    await advancePreparation(runId);
  }
  return runRow(runId);
}

/** The shape Drizzle gives a failed insert: the SQLSTATE is on the cause. */
function encodingFailure() {
  const cause = Object.assign(new Error('character with byte sequence 0xe2 0x80 0x8b in encoding "UTF8" has no equivalent in encoding "WIN1252"'), {
    code: "22P05",
  });
  return Object.assign(new Error(`Failed query: insert into "pkb_source_documents" values ($1)\nparams: ${"x".repeat(5000)}`), { cause });
}

// ------------------------------------------------------------------ jobs

describe("a job that failed for a reason that cannot change", () => {
  it("is not retried: one attempt, dead, with PostgreSQL's cause kept", async () => {
    let calls = 0;
    await enqueueJob({ kind: "test.encoding", maxAttempts: 5 });
    const report = await runDueJobs({
      "test.encoding": async () => {
        calls += 1;
        throw encodingFailure();
      },
    });
    expect(calls).toBe(1);
    expect(report.dead).toBe(1);
    const [row] = await harness.db.select().from(jobs);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("[22P05]");
    expect(row.lastError).toContain('no equivalent in encoding "WIN1252"');
    expect(row.lastError).not.toContain("xxxxx");
  });

  it("is still retried when the failure is transient", async () => {
    await enqueueJob({ kind: "test.deadlock", maxAttempts: 5 });
    const report = await runDueJobs({
      "test.deadlock": async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      },
    });
    expect(report.retried).toBe(1);
    const [row] = await harness.db.select().from(jobs);
    expect(row.status).toBe("queued");
  });
});

// ------------------------------------------------------ Fill with SeoPulse

describe("Fill with SeoPulse on a product nobody has researched", () => {
  it("writes no description and no key features, and says why", async () => {
    const listing = await makeListing();
    const result = await fillWithSeoPulse(staff, listing.id);

    expect(result.needsKnowledge?.message).toBe(
      "SeoPulse needs more verified product information before it can prepare customer content.",
    );
    expect(result.filled).not.toContain("Description");
    expect(result.filled).not.toContain("Key features");
    const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(row.descriptionHtml ?? "").toBe("");
    expect(row.bulletFeatures ?? []).toEqual([]);
    expect(row.descriptionHtml ?? "").not.toContain("Electronics range");
  });

  it("keeps what staff wrote", async () => {
    const listing = await makeListing();
    await harness.db
      .update(products)
      .set({ descriptionHtml: "<p>Our own words about the Model O.</p>", bulletFeatures: ["Part number: GO-WHITE"] })
      .where(eq(products.id, listing.id));
    await fillWithSeoPulse(staff, listing.id);
    const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(row.descriptionHtml).toBe("<p>Our own words about the Model O.</p>");
    expect(row.bulletFeatures).toEqual(["Part number: GO-WHITE"]);
  });
});

// ---------------------------------------------------------- preparation

describe("preparation, when the page was read and could not be stored", () => {
  it("says so in staff words, without the database's, and lets a retry research afresh", async () => {
    const listing = await makeListing();
    const run = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const finished = await drive(run.id, async (id) => {
      await harness.db
        .update(pkbEnrichmentRuns)
        .set({
          status: "failed",
          error: 'source_storage_encoding: https://www.gloriousgaming.com/p — [22P05] character with byte sequence 0xe2 0x80 0x8b in encoding "UTF8" has no equivalent in encoding "WIN1252"',
          finishedAt: new Date(),
        })
        .where(eq(pkbEnrichmentRuns.id, id));
    });

    expect(finished.stage).toBe("BLOCKED");
    expect(finished.failure?.code).toBe(PREPARATION_CODES.SOURCE_STORAGE_FAILED);
    expect(finished.failure?.message).toBe("We read the product page but could not store the retrieved information.");
    expect(finished.failure?.remedy).toMatch(/UTF-8/);
    expect(JSON.stringify(finished.failure)).not.toMatch(/22P05|WIN1252|byte sequence|insert into/);
    expect(finished.enrichmentRunId).toBeNull();
    expect(JSON.stringify(finished.steps)).not.toContain("Research did not finish");
  });
});

describe("preparation, when the page describes a different product", () => {
  it("stops for a person, shows both identities and the page, and changes nothing", async () => {
    const listing = await makeListing();
    const url = "https://www.gloriousgaming.com/products/model-o-classic-wireless-mouse";
    const run = await startPreparation(staff, listing.id, { requestKey: requestKey() });
    const finished = await drive(run.id, async (id) => {
      // The address staff attached is already a source row.
      const [source] = await harness.db.select({ id: pkbSources.id }).from(pkbSources).where(eq(pkbSources.url, url));
      await harness.db.insert(pkbSourceDocuments).values({
        sourceId: source.id,
        pkbProductId: listing.pkbProductId,
        runId: id,
        status: "retrieved",
        textContent: "Model O Classic Wireless Mouse",
        identityMatch: "mismatch",
        identityNotes: {
          recorded: { name: "Glorious Model O", brands: ["Glorious"], models: ["GO-WHITE"], gtins: [] },
          found: { names: ["Model O Classic Wireless Mouse"], brands: ["Glorious"], models: [], skus: ["GLO-OC-WL-BLK"], gtins: ["840408304115"] },
        },
      });
      await harness.db
        .update(pkbEnrichmentRuns)
        .set({ status: "completed", documentsRetrieved: 1, finishedAt: new Date() })
        .where(eq(pkbEnrichmentRuns.id, id));
    });

    expect(finished.stage).toBe("NEEDS_REVIEW");
    const note = finished.review.find((entry) => entry.code === PREPARATION_CODES.SOURCE_IDENTITY_MISMATCH);
    expect(note?.message).toBe("The product page appears to describe a different product.");
    expect(note?.comparison?.url).toBe(url);
    expect(note?.comparison?.recorded).toContainEqual({ label: "Model / part number", values: ["GO-WHITE"] });
    expect(note?.comparison?.found).toContainEqual({ label: "SKU", values: ["GLO-OC-WL-BLK"] });
    expect(note?.comparison?.found).toContainEqual({ label: "GTIN", values: ["840408304115"] });

    // The recorded identity is exactly what staff entered.
    const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(JSON.stringify(row.details)).toContain("GO-WHITE");
    expect(JSON.stringify(row.details)).not.toContain("GLO-OC-WL-BLK");
    expect(finished.enrichmentRunId).toBeNull();

    // The editor and the preview say the research is not done.
    const status = await productResearchStatus(staff, listing.id);
    expect(status).toMatchObject({ state: "incomplete", label: "Research incomplete" });
  });
});
