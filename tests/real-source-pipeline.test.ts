/**
 * The stored side of reading a real manufacturer's page (D-074, D-112).
 *
 * These are the defects a live run found that only a database shows: a source
 * row that violated its own constraint, a second read of the same page that
 * failed the run, a review action whose reply could not be serialised, and a
 * page read but not used with nothing said about why. Nothing here goes over
 * the network.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAttributeDefinitions,
  pkbClaims,
  pkbEnrichmentRuns,
  pkbFacts,
  pkbSourceDocuments,
  pkbSources,
  productPreparationRuns,
  products,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { createCategoryAttribute } from "@/lib/catalog/category-attributes";
import { provideDocument, sourceTypeForRole } from "@/lib/pkb/enrichment";
import { correctClaim } from "@/lib/pkb/review";
import { advancePreparation, startPreparation } from "@/lib/preparation";
import { processSearchQueue } from "@/lib/search/maintenance";
import { loadPulseInput } from "@/lib/seo-pulse/service";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let keys = 0;
const requestKey = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;

const OFFICIAL_URL = "https://docs.harbor-acoustics.test/hp-900";
const OFFICIAL_PAGE = [
  "Model: HP-900",
  "Brand: Harbor Acoustics",
  "Mass: 254 g",
  "Impedance: 48 ohm",
].join("\n");

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
  const category = await createCategory(staff, { name: "Audio", slug: `audio-${++keys}` });
  categoryId = category.id;
});

async function makeListing() {
  const product = await createProduct(staff, {
    categoryId,
    title: "Harbor Acoustics HP-900",
    brand: "Harbor Acoustics",
    identity: { modelName: "HP-900", modelNumber: "HP-900" },
  } as Parameters<typeof createProduct>[1]);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return { listing, pkbProductId: listing.pkbProductId! };
}

describe("the source row a retrieved page is recorded under", () => {
  it("records both address columns, which its own constraint requires", async () => {
    const { pkbProductId } = await makeListing();
    await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: OFFICIAL_PAGE,
      url: OFFICIAL_URL,
    });

    const [source] = await harness.db.select().from(pkbSources).where(eq(pkbSources.url, OFFICIAL_URL));
    expect(source.urlNormalized).toBe(OFFICIAL_URL);
  });

  it("is reused when the same page with the same content is read again", async () => {
    const { pkbProductId } = await makeListing();
    const first = await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: OFFICIAL_PAGE,
      url: OFFICIAL_URL,
    });
    // The second read is what a retry, or a second product citing the same
    // specification sheet, does. It used to fail the whole run.
    const second = await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: OFFICIAL_PAGE,
      url: OFFICIAL_URL,
    });

    expect(first.claimsProposed).toBeGreaterThan(0);
    expect(second).toBeTruthy();
    const rows = await harness.db.select().from(pkbSources).where(eq(pkbSources.urlNormalized, OFFICIAL_URL));
    expect(rows).toHaveLength(1);
  });
});

describe("an approved registry role decides what kind of source a page is", () => {
  it("maps each official role onto the source type a verification policy reads", () => {
    expect(sourceTypeForRole("official_documentation")).toBe("manufacturer_documentation");
    expect(sourceTypeForRole("official_product")).toBe("manufacturer_website");
    expect(sourceTypeForRole("official_support")).toBe("manufacturer_support");
    // Anything nobody classified stays what it is: a page on the web.
    expect(sourceTypeForRole("approved_secondary")).toBe("public_web");
  });
});

describe("a category specification whose value already spells its unit", () => {
  it("is not given the unit a second time", async () => {
    const weight = await createCategoryAttribute(staff, categoryId, {
      name: "Weight",
      dataType: "text",
      unit: "g",
    });
    const { listing } = await makeListing();
    await updateProduct(staff, listing.id, { attributeValues: { [weight.id]: "665g" } });

    const input = await loadPulseInput(listing.id);
    const row = input!.specifications.find((entry) => entry.label === "Weight");
    expect(row?.value).toBe("665g");
  });
});

describe("correcting a proposed value during review", () => {
  it("answers with a result the API can serialise", async () => {
    const { pkbProductId } = await makeListing();
    await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: OFFICIAL_PAGE,
      url: OFFICIAL_URL,
    });
    const claims = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId));
    const open = claims.find((row) => row.status === "SUGGESTED");
    expect(open).toBeTruthy();

    const result = await correctClaim(staff, open!.id, "254 g", "Unit tidied.");
    expect(result).toMatchObject({ claimId: open!.id, status: "REJECTED" });
    expect(() => JSON.stringify(result)).not.toThrow();

    const [fact] = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, pkbProductId), eq(pkbFacts.definitionId, open!.definitionId!)));
    expect(fact.verificationState).toBe("MANUAL");
  });
});

describe("a page that was read but says nothing about this product", () => {
  it("says so, rather than reporting nothing proposed and moving on", async () => {
    const { listing, pkbProductId } = await makeListing();
    const run = await startPreparation(staff, listing.id, {
      requestKey: requestKey(),
      urls: [OFFICIAL_URL],
    });

    // The run reaches the research step, which is where it asks for one.
    await advancePreparation(run.id);

    // The worker's outcome, without the network: one document retrieved, and
    // its identity signals did not settle which product it is for.
    await harness.db
      .update(pkbEnrichmentRuns)
      .set({ status: "completed", finishedAt: new Date(), documentsRetrieved: 1, claimsProposed: 0 })
      .where(eq(pkbEnrichmentRuns.status, "queued"));
    const [enrichment] = await harness.db.select().from(pkbEnrichmentRuns);
    expect(enrichment).toBeTruthy();
    const [source] = await harness.db
      .insert(pkbSources)
      .values({
        sourceType: "public_web",
        acquisitionMethod: "staff_url",
        origin: "APPROVED_EXTERNAL_SOURCE",
        usageRights: "internal_only",
        url: "https://docs.harbor-acoustics.test/range",
        urlNormalized: "https://docs.harbor-acoustics.test/range",
        domain: "docs.harbor-acoustics.test",
        retrievedAt: new Date(),
      })
      .returning({ id: pkbSources.id });
    await harness.db.insert(pkbSourceDocuments).values({
      sourceId: source.id,
      pkbProductId,
      runId: enrichment.id,
      status: "retrieved",
      httpStatus: 200,
      contentType: "text/html",
      byteSize: 64,
      sha256: "b".repeat(64),
      textContent: "The Harbor Acoustics range.",
      identityMatch: "unknown",
    });

    for (let round = 0; round < 10; round += 1) {
      const [before] = await harness.db
        .select()
        .from(productPreparationRuns)
        .where(eq(productPreparationRuns.id, run.id));
      if (before.finishedAt || before.stage === "NEEDS_REVIEW") break;
      await processSearchQueue();
      await advancePreparation(run.id);
    }

    const [after] = await harness.db
      .select()
      .from(productPreparationRuns)
      .where(eq(productPreparationRuns.id, run.id));
    const step = after.steps.find((entry) => entry.key === "enrichment");
    expect(step?.state).toBe("degraded");
    expect(step?.detail).toContain("does not say enough about which product");
  });
});

describe("claims a run proposed are never accepted by the run", () => {
  it("leaves every proposed value waiting for a person", async () => {
    const { pkbProductId } = await makeListing();
    await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: OFFICIAL_PAGE,
      url: OFFICIAL_URL,
    });
    const rows = await harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "SUGGESTED" || row.status === "CONFLICT")).toBe(true);
  });
});

describe("a list attribute a page writes as one bulleted value", () => {
  it("is proposed one item per slot, not as one run-on item (D-119)", async () => {
    const { pkbProductId } = await makeListing();
    await provideDocument(staff, pkbProductId, {
      title: "HP-900 specifications",
      content: [OFFICIAL_PAGE, "In the box: • 1× HP-900 • 1× USB-C cable • 1× Carry case"].join("\n"),
      url: OFFICIAL_URL,
    });

    const [boxContents] = await harness.db
      .select({ id: pkbAttributeDefinitions.id })
      .from(pkbAttributeDefinitions)
      .where(eq(pkbAttributeDefinitions.key, "box_contents"));
    const claims = await harness.db
      .select({ ordinal: pkbClaims.ordinal, raw: pkbClaims.rawValue })
      .from(pkbClaims)
      .where(and(eq(pkbClaims.pkbProductId, pkbProductId), eq(pkbClaims.definitionId, boxContents.id)));
    expect(claims.sort((a, b) => a.ordinal - b.ordinal)).toEqual([
      { ordinal: 0, raw: "1× HP-900" },
      { ordinal: 1, raw: "1× USB-C cable" },
      { ordinal: 2, raw: "1× Carry case" },
    ]);
  });
});
