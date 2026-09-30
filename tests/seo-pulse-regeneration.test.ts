/**
 * Generate and regenerate, and whose words are whose (D-120).
 *
 * SEO Pulse may replace wording it wrote itself, when asked. It never replaces
 * wording a person wrote or edited, unless that person chooses the SEO Pulse
 * version after seeing it — and nothing in the background ever does. Against a
 * real database, with the rules generator; nothing here reaches the network.
 */
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { products, seoFieldHistory, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { JOB_HANDLERS } from "@/lib/jobs/registry";
import { runDueJobs } from "@/lib/jobs/runner";
import { contentOwnership, setFieldLock } from "@/lib/seo/fields";
import {
  fillWithSeoPulse,
  loadPulseInput,
  regenerateWithSeoPulse,
  runSeoPulse,
  seoPulseRecommendations,
  SeoPulseError,
} from "@/lib/seo-pulse";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let keys = 0;

const FIRST_FACTS = [
  { label: "Sensor", value: "BAMF 2.0 optical sensor" },
  { label: "Connectivity", value: "2.4 GHz wireless, wired" },
  { label: "Battery life", value: "Up to 80 hours" },
];
const MORE_FACTS = [
  ...FIRST_FACTS,
  { label: "Polling rate", value: "1000 Hz" },
  { label: "Switch type", value: "Glorious mechanical switches" },
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
  const category = await createCategory(staff, { name: "Electronics", slug: `electronics-${++keys}` });
  categoryId = category.id;
});

/** A product with enough established about it for SEO Pulse to write customer content. */
async function researchedProduct() {
  const product = await createProduct(staff, {
    categoryId,
    title: "Glorious Model O Classic Wireless Mouse",
    brand: "Glorious",
    identity: { modelName: "Model O Classic Wireless", modelNumber: "GLO-OC-WL-BLK", mpn: "GLO-OC-WL-BLK" },
  } as Parameters<typeof createProduct>[1]);
  await updateProduct(staff, product.id, {
    specTable: FIRST_FACTS,
    measurements: [{ label: "Weight", value: "69 g" }],
    boxContents: ["1× USB receiver", "1× USB-A to USB-C cable", "1× USB-A to USB-C adapter"],
  });
  return product.id;
}

async function listing(id: string) {
  const [row] = await harness.db.select().from(products).where(eq(products.id, id));
  return row;
}

async function owner(id: string, field: "descriptionHtml" | "bulletFeatures") {
  return (await contentOwnership(harness.db, id, [field])).get(field);
}

/** Better knowledge arrives, and SEO Pulse prepares again — as preparation would. */
async function knowledgeImproves(id: string) {
  await updateProduct(staff, id, { specTable: MORE_FACTS });
  const { run } = await runSeoPulse(staff, id, { requestKey: crypto.randomUUID(), fresh: false });
  return run.id;
}

async function latestHistory(id: string, field: "descriptionHtml" | "bulletFeatures") {
  const [row] = await harness.db
    .select()
    .from(seoFieldHistory)
    .where(and(eq(seoFieldHistory.productId, id), eq(seoFieldHistory.field, field)))
    .orderBy(desc(seoFieldHistory.createdAt))
    .limit(1);
  return row;
}

describe("who owns what a field holds", () => {
  it("tells SEO Pulse's own wording from a person's edit of it", async () => {
    const id = await researchedProduct();
    expect(await owner(id, "descriptionHtml")).toBe("empty");

    const fill = await fillWithSeoPulse(staff, id);
    expect(fill.filled).toContain("Description");
    expect(await owner(id, "descriptionHtml")).toBe("seo_pulse");

    // Saving the section without changing the description does not take it over.
    const saved = await listing(id);
    await updateProduct(staff, id, { descriptionHtml: saved.descriptionHtml, boxContents: saved.boxContents as string[] });
    expect(await owner(id, "descriptionHtml")).toBe("seo_pulse");

    await updateProduct(staff, id, { descriptionHtml: `${saved.descriptionHtml}<p>Our own note.</p>` });
    expect(await owner(id, "descriptionHtml")).toBe("staff");
  });

  it("treats a value no history accounts for as a person's", async () => {
    const id = await researchedProduct();
    await harness.db.update(products).set({ descriptionHtml: "<p>Imported copy.</p>" }).where(eq(products.id, id));
    expect(await owner(id, "descriptionHtml")).toBe("staff");
  });
});

describe("a description staff edited after SEO Pulse wrote it", () => {
  it("stays exactly as staff left it until staff choose to replace it", async () => {
    const id = await researchedProduct();
    await fillWithSeoPulse(staff, id); // A
    const edited = "<p>The Model O, as our buyers describe it after a month of use.</p>"; // B
    await updateProduct(staff, id, { descriptionHtml: edited });

    const runId = await knowledgeImproves(id); // C is prepared
    // Every automatic path that could touch it runs: Fill, and the job queue.
    const fill = await fillWithSeoPulse(staff, id);
    await runDueJobs(JOB_HANDLERS, { budgetMs: 5_000 });
    expect((await listing(id)).descriptionHtml).toBe(edited);
    expect(fill.kept).toContain("Description");
    expect(fill.newerVersions).toContainEqual({ field: "descriptionHtml", label: "Description", owner: "staff" });

    const recommendations = await seoPulseRecommendations(staff, id);
    const offered = recommendations?.fields.find((entry) => entry.field === "descriptionHtml");
    expect(offered?.owner).toBe("staff");
    expect(offered?.current).toBe(edited);
    expect(offered?.proposed).toContain("polling rate");

    // Regenerate, which is for SEO Pulse's own wording, refuses.
    const refused = await regenerateWithSeoPulse(staff, id, { runId: recommendations!.runId, fields: ["descriptionHtml"], replaceStaff: false }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SeoPulseError);
    expect((refused as SeoPulseError).status).toBe(409);
    expect((await listing(id)).descriptionHtml).toBe(edited);

    // Staff saw C and chose it.
    await regenerateWithSeoPulse(staff, id, { runId: recommendations!.runId, fields: ["descriptionHtml"], replaceStaff: true });
    const after = await listing(id);
    expect(after.descriptionHtml).toBe(offered?.proposed);
    const history = await latestHistory(id, "descriptionHtml");
    expect(history.beforeValue).toBe(edited);
    expect(history.afterValue).toBe(after.descriptionHtml);
    expect(history.reason).toBe("Replaced with the SEO Pulse version by staff");
    expect(history.sourceRunId).toBe(runId);
  });

  it("is never replaced while locked, even when staff ask", async () => {
    const id = await researchedProduct();
    await fillWithSeoPulse(staff, id);
    await updateProduct(staff, id, { descriptionHtml: "<p>Ours.</p>" });
    await setFieldLock(staff, id, "descriptionHtml", true);
    const runId = await knowledgeImproves(id);

    await expect(
      regenerateWithSeoPulse(staff, id, { runId, fields: ["descriptionHtml"], replaceStaff: true }),
    ).rejects.toThrow(/locked/);
    expect((await listing(id)).descriptionHtml).toBe("<p>Ours.</p>");
  });
});

describe("a description SEO Pulse wrote and nobody touched", () => {
  it("is regenerated on request, with the replacement in the history", async () => {
    const id = await researchedProduct();
    await fillWithSeoPulse(staff, id);
    const first = (await listing(id)).descriptionHtml; // A
    const firstFeatures = (await listing(id)).bulletFeatures;

    const runId = await knowledgeImproves(id);
    // Preparing C wrote nothing.
    expect((await listing(id)).descriptionHtml).toBe(first);

    const recommendations = await seoPulseRecommendations(staff, id);
    expect(recommendations?.runId).toBe(runId);
    const offered = recommendations?.fields.find((entry) => entry.field === "descriptionHtml");
    expect(offered?.owner).toBe("seo_pulse");

    await regenerateWithSeoPulse(staff, id, { runId, fields: ["descriptionHtml", "bulletFeatures"], replaceStaff: false });
    const after = await listing(id);
    expect(after.descriptionHtml).toBe(offered?.proposed);
    expect(after.descriptionHtml).not.toBe(first);
    // The new features come from the new facts, not from the old features.
    expect(after.bulletFeatures).not.toEqual(firstFeatures);
    expect(after.bulletFeatures).toContain("1000 Hz polling rate");
    // What is in the box is its own list, never one item of it as a feature.
    expect((after.bulletFeatures as string[]).some((line) => /in the box/i.test(line))).toBe(false);
    expect(after.descriptionHtml).toContain("<h2>In the box</h2><ul><li>1× USB receiver</li><li>1× USB-A to USB-C cable</li>");

    const history = await latestHistory(id, "descriptionHtml");
    expect(history.beforeValue).toBe(first);
    expect(history.afterValue).toBe(after.descriptionHtml);
    expect(history.workflow).toBe("seo_pulse_apply");
    expect(history.reason).toBe("Regenerated with SEO Pulse");
    expect(history.sourceRunId).toBe(runId);
    // Still SEO Pulse's, so the next improvement can regenerate it again.
    expect(await owner(id, "descriptionHtml")).toBe("seo_pulse");
  });

  it("is not replaced from research older than the latest", async () => {
    const id = await researchedProduct();
    const fill = await fillWithSeoPulse(staff, id);
    await knowledgeImproves(id);
    await expect(
      regenerateWithSeoPulse(staff, id, { runId: fill.runId, fields: ["descriptionHtml"], replaceStaff: false }),
    ).rejects.toThrow(/Newer SEO Pulse research/);
  });
});

describe("SEO Pulse's own wording is not evidence", () => {
  it("does not count its own description or features towards a researched product", async () => {
    const product = await createProduct(staff, {
      categoryId,
      title: "Glorious Model O",
      brand: "Glorious",
      identity: { modelNumber: "GO-WHITE" },
    } as Parameters<typeof createProduct>[1]);
    // Features and a long description, as a staff member might write them.
    await updateProduct(staff, product.id, {
      bulletFeatures: ["Honeycomb shell"],
      descriptionHtml: `<p>${"A light, fast mouse for competitive play. ".repeat(8)}</p>`,
    });
    const staffWritten = knowledgeSufficiency((await loadPulseInput(product.id))!);

    // The same words, had SEO Pulse written them, vouch for nothing.
    const input = (await loadPulseInput(product.id))!;
    const generated = knowledgeSufficiency({ ...input, pulseWritten: { description: true, bulletFeatures: true } });
    expect(generated.facts).toBe(staffWritten.facts - 2);
    expect(generated.missing).toContain("Key features");
  });
});
