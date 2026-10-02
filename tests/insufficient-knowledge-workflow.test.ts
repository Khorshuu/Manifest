/**
 * Too little established knowledge, and what staff are told to do about it.
 *
 * Accepting a proposed value is a decision; it is not verification. A value
 * accepted from a source no verification policy qualifies is recorded as
 * UNVERIFIED and is not established knowledge, so preparation still stops —
 * and it must say so, rather than telling the reviewer to accept the values
 * again, and must not offer the same values for the same decision each time
 * the source is read.
 *
 * Synthetic documents throughout: a retailer's listing (no policy qualifies
 * it) and an official specification a staff member supplies (the
 * `admin_provided_official_document` policy does). Nothing is fetched and no
 * generator other than the rules one runs.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAttributeProposals,
  pkbClaims,
  pkbEnrichmentRuns,
  pkbFacts,
  productPreparationRuns,
  products,
  seoResearchRuns,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { decisionMessage } from "@/lib/pkb/claim-selection";
import { decideAttributeProposal } from "@/lib/pkb/discovery";
import { provideDocument } from "@/lib/pkb/enrichment";
import { acceptClaims } from "@/lib/pkb/review";
import { evaluateVerification } from "@/lib/pkb/trust";
import { advancePreparation, continuePreparation, PREPARATION_CODES, startPreparation } from "@/lib/preparation";
import { describeIssue } from "@/lib/preparation/presentation";
import { setProductResearchProviderForTesting } from "@/lib/providers/research";
import { processSearchQueue } from "@/lib/search/maintenance";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { loadPulseInput } from "@/lib/seo-pulse/service";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let keys = 0;

const requestKey = () => `00000000-0000-4000-a000-${String(++keys).padStart(12, "0")}`;

/**
 * Labels no attribute names yet, as on the retailer page of the live run: each
 * becomes an attribute of this product only, and none is a field of the listing.
 */
const SHEET = ["Driver size: 40 mm", "Bluetooth version: 5.4", "Battery life: 30 hours", "Charging port: USB-C"].join("\n");

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
  const [row] = await harness.db
    .insert(users)
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
  categoryId = (await createCategory(staff, { name: "Audio", slug: `audio-${++keys}` })).id;
});

type ListingInput = Parameters<typeof createProduct>[1];

/** Identified, with a source to read, and nothing established about it. */
async function thinListing() {
  const product = await createProduct(staff, {
    categoryId,
    title: "HP-900 Headphones",
    brand: "Harbor Acoustics",
    identity: { modelNumber: "HP-900", officialUrl: "https://harbor-acoustics.test/hp-900" },
  } as ListingInput);
  const [listing] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return { id: listing.id, pkbProductId: listing.pkbProductId! };
}

/** Names every label still waiting, for this product only. The decision is remembered. */
async function nameLabels(pkbProductId: string) {
  const open = await harness.db
    .select({ id: pkbAttributeProposals.id })
    .from(pkbAttributeProposals)
    .where(and(eq(pkbAttributeProposals.pkbProductId, pkbProductId), eq(pkbAttributeProposals.status, "open")));
  for (const proposal of open) await decideAttributeProposal(staff, proposal.id, { action: "product_only" });
}

/** A retailer's listing of the product: readable, and qualified by no policy. */
async function retailerPage(pkbProductId: string, content = SHEET, title = "Retailer listing") {
  const outcome = await provideDocument(staff, pkbProductId, { title, content, sourceType: "retailer" });
  await nameLabels(pkbProductId);
  return outcome;
}

async function runRow(runId: string) {
  const [row] = await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return row;
}

/** Drives the run to its next resting place, finishing research as the worker would. */
async function drive(runId: string, rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    const before = await runRow(runId);
    if (!before || before.finishedAt || before.stage === "NEEDS_REVIEW") break;
    await harness.db
      .update(pkbEnrichmentRuns)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(pkbEnrichmentRuns.status, "queued"));
    await processSearchQueue();
    await advancePreparation(runId);
  }
  return runRow(runId);
}

const claimsOf = (pkbProductId: string) => harness.db.select().from(pkbClaims).where(eq(pkbClaims.pkbProductId, pkbProductId));

const openClaims = async (pkbProductId: string) =>
  (await claimsOf(pkbProductId)).filter((claim) => claim.status === "SUGGESTED" || claim.status === "CONFLICT");

/** The values a person accepted from a claim (what staff typed on the listing has no claim). */
const acceptedFacts = async (pkbProductId: string) =>
  (await harness.db.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId))).filter((fact) => fact.claimId !== null);

const note = (run: Awaited<ReturnType<typeof runRow>>, code: string) => run.review.find((entry) => entry.code === code);

/** A product whose retailer values were read, proposed and accepted without verification. */
async function acceptedUnverified() {
  const listing = await thinListing();
  await retailerPage(listing.pkbProductId);
  const started = await startPreparation(staff, listing.id, { requestKey: requestKey() });
  await drive(started.id);
  const open = await openClaims(listing.pkbProductId);
  await acceptClaims(staff, { claimIds: open.map((claim) => claim.id) });
  await continuePreparation(staff, started.id);
  return { listing, runId: started.id, run: await drive(started.id) };
}

describe("values waiting for a decision", () => {
  it("sends staff to review them, and does not promise that accepting establishes them", async () => {
    const listing = await thinListing();
    await retailerPage(listing.pkbProductId);
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);

    expect(run.stage).toBe("NEEDS_REVIEW");
    const waiting = note(run, PREPARATION_CODES.CLAIMS_WAITING)!;
    expect(waiting.message).toMatch(/4 values proposed from sources, waiting/);
    expect(waiting.remedy).toMatch(/review them/i);
    expect(waiting.remedy).toMatch(/accepted as verified/);
    expect(waiting.remedy).not.toMatch(/Accepted values then count as established/);
    // The decision is taken in Product Intelligence, and that is where the button goes.
    expect(describeIssue(waiting).actions[0]).toBe("intelligence");
  });
});

describe("values accepted from a source no policy qualifies", () => {
  it("stay unverified, and cannot be accepted as verified", async () => {
    const listing = await thinListing();
    await retailerPage(listing.pkbProductId);
    const open = await openClaims(listing.pkbProductId);
    expect(open).toHaveLength(4);
    for (const claim of open) expect((await evaluateVerification(harness.db, claim.id)).eligible).toBe(false);

    await expect(acceptClaims(staff, { claimIds: open.map((claim) => claim.id), asVerified: true })).rejects.toThrow(/Not verifiable/);
    expect(await acceptedFacts(listing.pkbProductId)).toHaveLength(0);

    const result = await acceptClaims(staff, { claimIds: open.map((claim) => claim.id) });
    expect(result).toEqual({ accepted: 4, verified: 0 });
    const facts = await acceptedFacts(listing.pkbProductId);
    expect(facts.map((fact) => fact.verificationState)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED"]);
    // What the review screen says after a plain accept.
    expect(decisionMessage("accept", { decided: 4, failed: 0, error: null })).toBe("Accepted 4 values as unverified.");
  });

  it("keep preparation stopped, with no content written", async () => {
    const { listing, run } = await acceptedUnverified();

    expect(run.stage).toBe("NEEDS_REVIEW");
    expect(run.review.map((entry) => entry.code)).toEqual([PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE]);
    expect(knowledgeSufficiency((await loadPulseInput(listing.id))!).sufficient).toBe(false);
    expect(await harness.db.select().from(seoResearchRuns)).toHaveLength(0);
    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(after.descriptionHtml ?? "").toBe("");
    expect(after.seoMetaTitle ?? "").toBe("");
  });

  it("are named as accepted and unverified, and staff are not told to accept them again", async () => {
    const { run } = await acceptedUnverified();
    const issue = describeIssue(note(run, PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE)!);

    expect(issue.message).toMatch(/4 values were accepted without verification \(Battery life, Bluetooth version, Charging port, Driver size\)/);
    expect(issue.message).toMatch(/do not count as established/);
    expect(issue.remedy).not.toMatch(/Accept the values research found/i);
    expect(issue.remedy).toMatch(/Accepting the unverified values again will not change this/);
    // What it asks for instead is something the screen can do.
    expect(issue.remedy).toMatch(/official specification/);
    expect(issue.remedy).toMatch(/accept the values as verified/);
    expect(issue.remedy).toMatch(/enter the specifications by hand/);
    expect(issue.actions).toEqual(["sources", "specifications", "recheck", "manual"]);
  });

  it("are not said to be accepted when nothing was", async () => {
    const listing = await thinListing();
    const run = await drive((await startPreparation(staff, listing.id, { requestKey: requestKey() })).id);
    const insufficient = note(run, PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE)!;

    expect(insufficient.message).not.toMatch(/accepted without verification/);
    expect(insufficient.remedy).not.toMatch(/Accept the values research found/i);
    expect(insufficient.remedy).toMatch(/Add them by hand, or attach the manufacturer's page or specification/);
  });
});

describe("the same source read again", () => {
  it("does not offer the accepted values for the same decision a second time", async () => {
    const { listing, runId } = await acceptedUnverified();

    // The same statements from the same kind of source, as a re-read returns them.
    const outcome = await retailerPage(listing.pkbProductId, SHEET, "Retailer listing, read again");
    expect(outcome.claimsProposed).toBe(4);
    expect(await openClaims(listing.pkbProductId)).toHaveLength(0);
    const repeats = (await claimsOf(listing.pkbProductId)).filter((claim) => claim.status === "SUPERSEDED");
    expect(repeats).toHaveLength(4);
    expect(repeats[0].decisionNote).toMatch(/already accepted as unverified/);
    expect(repeats.every((claim) => claim.decidedAt === null && claim.decidedBy === null)).toBe(true);

    // The repeat verified nothing.
    const facts = await acceptedFacts(listing.pkbProductId);
    expect(facts.every((fact) => fact.verificationState === "UNVERIFIED")).toBe(true);

    // Continuing stops in the same place for the same reason, not at "waiting for you".
    await continuePreparation(staff, runId);
    const run = await drive(runId);
    expect(run.review.map((entry) => entry.code)).toEqual([PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE]);
  });

  it("still raises a value that changed", async () => {
    const { listing } = await acceptedUnverified();

    await retailerPage(listing.pkbProductId, "Battery life: 40 hours", "Retailer listing, revised");
    const open = await openClaims(listing.pkbProductId);
    expect(open.map((claim) => [claim.rawValue, claim.status])).toEqual([["40 hours", "CONFLICT"]]);
  });

  it("still proposes a value the product does not have yet", async () => {
    const { listing } = await acceptedUnverified();

    await retailerPage(listing.pkbProductId, [SHEET, "Size: Over-ear"].join("\n"), "Retailer listing, longer");
    const open = await openClaims(listing.pkbProductId);
    expect(open.map((claim) => [claim.rawValue, claim.status])).toEqual([["Over-ear", "SUGGESTED"]]);
  });
});

describe("qualifying evidence arriving later", () => {
  it("is offered for the same values, verifies them, and lets preparation finish", async () => {
    const { listing, runId } = await acceptedUnverified();

    // The manufacturer's specification, supplied by staff through the run itself.
    await continuePreparation(staff, runId, { document: { title: "HP-900 official specification", content: SHEET } });
    const open = await openClaims(listing.pkbProductId);
    expect(open).toHaveLength(4);
    expect(open.every((claim) => claim.status === "SUGGESTED")).toBe(true);
    for (const claim of open) {
      const qualification = await evaluateVerification(harness.db, claim.id);
      expect(qualification.eligible).toBe(true);
      expect(qualification.policy?.key).toBe("admin_provided_official_document");
    }

    // Until somebody decides, the run waits: the evidence alone verifies nothing.
    const waiting = await drive(runId);
    expect(waiting.review.map((entry) => entry.code)).toEqual([PREPARATION_CODES.CLAIMS_WAITING]);
    expect((await acceptedFacts(listing.pkbProductId)).every((fact) => fact.verificationState === "UNVERIFIED")).toBe(true);

    const result = await acceptClaims(staff, { claimIds: open.map((claim) => claim.id), asVerified: true });
    expect(result.verified).toBe(4);
    const facts = await acceptedFacts(listing.pkbProductId);
    expect(facts.map((fact) => fact.verificationState)).toEqual(["VERIFIED", "VERIFIED", "VERIFIED", "VERIFIED"]);
    expect(facts.every((fact) => fact.decisionPolicy === "admin_provided_official_document")).toBe(true);

    await continuePreparation(staff, runId);
    const ready = await drive(runId);
    expect(ready.id).toBe(runId);
    expect(ready.stage).toBe("READY");
    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    expect(after.descriptionHtml).toBeTruthy();
  });

  it("is still only unverified when accepted without asking for verification", async () => {
    const listing = await thinListing();
    await provideDocument(staff, listing.pkbProductId, { title: "HP-900 official specification", content: SHEET });
    await nameLabels(listing.pkbProductId);
    const open = await openClaims(listing.pkbProductId);
    expect(open).toHaveLength(4);
    await acceptClaims(staff, { claimIds: open.map((claim) => claim.id) });
    const facts = await acceptedFacts(listing.pkbProductId);
    expect(facts.every((fact) => fact.verificationState === "UNVERIFIED" && fact.decisionPolicy === null)).toBe(true);
    expect(knowledgeSufficiency((await loadPulseInput(listing.id))!).sufficient).toBe(false);
  });
});

describe("the facts entered by hand", () => {
  it("are established without a source, and preparation finishes", async () => {
    const { listing, runId } = await acceptedUnverified();

    await updateProduct(staff, listing.id, {
      specTable: [
        { label: "Driver", value: "40 mm" },
        { label: "Connectivity", value: "Bluetooth 5.4" },
        { label: "Noise cancelling", value: "Active" },
      ],
    });
    await continuePreparation(staff, runId);
    const ready = await drive(runId);
    expect(ready.id).toBe(runId);
    expect(ready.stage).toBe("READY");

    // Typing other facts verified none of the accepted ones.
    const unverified = await harness.db
      .select()
      .from(pkbFacts)
      .where(and(eq(pkbFacts.pkbProductId, listing.pkbProductId), eq(pkbFacts.verificationState, "UNVERIFIED")));
    expect(unverified.filter((fact) => fact.decidedBy !== null)).toHaveLength(4);
  });
});
