/**
 * The publish schedule (lib/catalog/schedule.ts, D-056): a listing whose
 * publish date has passed goes live through the same check a person runs, an
 * unfinished one stays a draft and keeps its date, an unpublish date takes a
 * live listing down, and two runs at once act on each listing once.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, productImages, productVariants, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { applyPublishSchedule, createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";

const now = new Date("2026-09-20T10:00:00Z");
const past = new Date(now.getTime() - 60_000);
const future = new Date(now.getTime() + 86_400_000);

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db
    .insert(users)
    .values({ email: staff.email, passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
  categoryId = (await createCategory(staff, { name: "Snacks", slug: "snacks" })).id;
});

/** A draft with everything the publish check requires. */
async function finishedDraft(title: string) {
  const product = await createProduct(staff, { title, categoryId });
  await harness.db.insert(productImages).values({ productId: product.id, url: "/uploads/a.webp", altText: "It" });
  await harness.db.insert(productVariants).values({
    productId: product.id,
    sku: `SKU-${title}`,
    priceBdt: 500_00,
    fulfillmentMode: "preorder",
    preorderCapacity: 10,
    preorderClosesAt: future,
  });
  return product;
}

async function statusOf(id: string) {
  const [row] = await harness.db
    .select({ status: products.status, publishAt: products.publishAt, unpublishAt: products.unpublishAt })
    .from(products)
    .where(eq(products.id, id));
  return row;
}

describe("publishing on a date", () => {
  it("puts a finished listing live once its date has passed, and clears the date", async () => {
    const product = await finishedDraft("due");
    await updateProduct(staff, product.id, { publishAt: past });

    const report = await applyPublishSchedule(now);

    expect(report.published).toEqual([product.id]);
    expect(await statusOf(product.id)).toMatchObject({ status: "preorder_open", publishAt: null });
    const entries = await harness.db.select().from(auditLog).where(eq(auditLog.entityId, product.id));
    expect(entries.some((entry) => (entry.afterJson as { status?: string } | null)?.status === "preorder_open")).toBe(true);
  });

  it("leaves a listing whose date has not come", async () => {
    const product = await finishedDraft("later");
    await updateProduct(staff, product.id, { publishAt: future });

    expect((await applyPublishSchedule(now)).published).toEqual([]);
    expect((await statusOf(product.id)).status).toBe("draft");
  });

  it("never publishes an unfinished listing, keeps its date, and says why", async () => {
    const product = await createProduct(staff, { title: "Unfinished", categoryId });
    await updateProduct(staff, product.id, { publishAt: past });

    const report = await applyPublishSchedule(now);

    expect(report.published).toEqual([]);
    expect(report.notReady).toHaveLength(1);
    expect(report.notReady[0].failures.join(" ")).toMatch(/photograph/);
    const row = await statusOf(product.id);
    expect(row.status).toBe("draft");
    expect(row.publishAt?.getTime()).toBe(past.getTime());
  });

  it("does not act for someone who no longer has catalogue access", async () => {
    const product = await finishedDraft("orphan");
    await updateProduct(staff, product.id, { publishAt: past });
    await harness.db.update(users).set({ role: "customer" }).where(eq(users.id, staff.id));

    const report = await applyPublishSchedule(now);

    expect(report.published).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect((await statusOf(product.id)).status).toBe("draft");
  });

  it("publishes each listing once when two runs overlap", async () => {
    const product = await finishedDraft("once");
    await updateProduct(staff, product.id, { publishAt: past });

    const [first, second] = await Promise.all([applyPublishSchedule(now), applyPublishSchedule(now)]);

    expect(first.published.length + second.published.length).toBe(1);
  });
});

describe("unpublishing on a date", () => {
  it("takes a live listing down once its date has passed, and clears the date", async () => {
    const product = await finishedDraft("seasonal");
    await updateProduct(staff, product.id, { status: "preorder_open", unpublishAt: past });

    const report = await applyPublishSchedule(now);

    expect(report.unpublished).toEqual([product.id]);
    expect(await statusOf(product.id)).toMatchObject({ status: "draft", unpublishAt: null });
  });
});
