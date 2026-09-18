/**
 * Stage 4 of the knowledge platform, second half: auditing.
 *
 * Image SEO (D-085), duplicate and thin content (D-086), the technical checks
 * (D-087), internal-link intelligence (D-088) and the shelf's own SEO fields
 * (D-084). Every one of these reads real rows and reports what is there; none
 * of them rewrites a listing, and none of them invents a product fact.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { categories, mediaObjects, productImages, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { addVariant, createCategory, createProduct, updateCategory, updateProduct } from "@/lib/catalog";
import { addRelationship } from "@/lib/pkb";
import { duplicateReport, listingDuplication } from "@/lib/seo/duplicates";
import { imageHealth, listingImageAudit, suggestAltText } from "@/lib/seo/images";
import { linkIntelligence } from "@/lib/seo/links";
import { listingTechnicalAudit, technicalHealth } from "@/lib/seo/technical";
import { categoryInputSchema } from "@/lib/validation/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };

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
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
});

async function shelf(name = "Audio") {
  return createCategory(staff, { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 7)}` });
}

async function listing(input: {
  title: string;
  categoryId?: string;
  status?: string;
  description?: string;
  metaDescription?: string;
}) {
  const categoryId = input.categoryId ?? (await shelf()).id;
  const product = await createProduct(staff, {
    title: input.title,
    categoryId,
    descriptionHtml: input.description ?? "<p>A description long enough to be worth reading on its own.</p>",
  });
  if (input.metaDescription) {
    await updateProduct(staff, product.id, { seoMetaDescription: input.metaDescription });
  }
  if (input.status) {
    await harness.db
      .update(products)
      .set({ status: input.status, firstPublishedAt: new Date() })
      .where(eq(products.id, product.id));
  }
  const [row] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return row;
}

async function photograph(
  productId: string,
  input: { url: string; alt: string; sort?: number; width?: number; height?: number; bytes?: number; type?: string },
) {
  await harness.db.insert(productImages).values({
    productId,
    url: input.url,
    altText: input.alt,
    sortOrder: input.sort ?? 0,
    kind: "gallery",
  });
  if (input.width !== undefined) {
    await harness.db.insert(mediaObjects).values({
      key: `key-${input.url}`,
      provider: "test",
      url: input.url,
      contentType: input.type ?? "image/jpeg",
      bytes: input.bytes ?? 100_000,
      width: input.width,
      height: input.height ?? input.width,
    });
  }
}

describe("image SEO", () => {
  it("names what is wrong with each photograph, and leaves the alt text alone", async () => {
    const product = await listing({ title: "Studio Headphones", status: "in_stock" });
    await photograph(product.id, { url: "/a.jpg", alt: "IMG_2043.jpg", width: 1600, bytes: 150_000 });
    await photograph(product.id, { url: "/b.jpg", alt: "Studio headphones on a stand", sort: 1, width: 400, bytes: 20_000 });
    await photograph(product.id, {
      url: "/c.jpg",
      alt: "Studio headphones on a stand",
      sort: 2,
      width: 2000,
      bytes: 900_000,
    });
    await photograph(product.id, { url: "/d.jpg", alt: "The earcup, folded flat", sort: 3 });

    const audit = await listingImageAudit(product.id, product.title, harness.db);
    const ids = audit.findings.map((finding) => finding.id.split(":")[0]);

    expect(ids).toContain("thin_alt"); // a filename describes nothing
    expect(ids).toContain("duplicate_alt"); // two photographs, one sentence
    expect(ids).toContain("small_image"); // 400px will not be shown
    expect(ids).toContain("heavy_image"); // 900 KB delays the page
    expect(ids).toContain("unknown_size"); // no media registry row

    // Nothing was changed by looking.
    const rows = await harness.db.select().from(productImages).where(eq(productImages.productId, product.id));
    expect(rows.map((row) => row.altText)).toContain("IMG_2043.jpg");
  });

  it("counts the same checks across the catalogue, ignoring listings shoppers cannot see", async () => {
    const live = await listing({ title: "Desk Lamp", status: "in_stock" });
    const draft = await listing({ title: "Unreleased Lamp" });
    await photograph(live.id, { url: "/live.jpg", alt: "image", width: 300, bytes: 700_000 });
    await photograph(draft.id, { url: "/draft.jpg", alt: "photo" });

    const health = await imageHealth(harness.db);
    expect(health.photographs).toBe(1);
    expect(health.withoutDescription).toBe(1);
    expect(health.tooSmall).toBe(1);
    expect(health.heavy).toBe(1);
  });

  it("suggests alt text only from what the shop has established", async () => {
    const product = await listing({ title: "Turntable", status: "in_stock" });
    // No brand fact yet: the suggestion is the listing's own name and nothing more.
    const bare = await suggestAltText({ title: product.title, pkbProductId: product.pkbProductId, position: 1 }, harness.db);
    expect(bare).toBe("Turntable");

    await updateProduct(staff, product.id, { brand: "Harbor Acoustics" });
    const [withBrand] = await harness.db.select().from(products).where(eq(products.id, product.id));
    const suggestion = await suggestAltText(
      { title: withBrand.title, pkbProductId: withBrand.pkbProductId, position: 2 },
      harness.db,
    );
    expect(suggestion).toBe("Harbor Acoustics Turntable — photograph 2");
    // Nothing about the picture itself was invented.
    expect(suggestion).not.toMatch(/front|angle|desk|white background/i);
  });
});

describe("duplicate and thin content", () => {
  it("groups listings that share wording, and separates a shared opening from a copy", async () => {
    const shared = "The same sentence, written once and pasted onto both listings so they read identically.";
    const first = await listing({ title: "Cable A", status: "in_stock", metaDescription: shared });
    await listing({ title: "Cable B", status: "in_stock", metaDescription: shared });

    // Longer than the 160-character bucket, so the two bodies share a bucket
    // and are then compared in full.
    const opening =
      "A long shared opening paragraph that both of these listings begin with, word for word, describing how the item is sourced in the United States and landed in Bangladesh at a fixed price.";
    await listing({
      title: "Stand A",
      status: "in_stock",
      description: `<p>${opening} Then this one talks about aluminium.</p>`,
    });
    await listing({
      title: "Stand B",
      status: "in_stock",
      description: `<p>${opening} Then this one talks about walnut instead.</p>`,
    });

    const report = await duplicateReport(harness.db);
    const metaGroup = report.groups.find((group) => group.field === "seo_meta_description");
    expect(metaGroup?.listings).toHaveLength(2);
    expect(report.nearDuplicateDescriptions).toHaveLength(1);

    const mine = await listingDuplication(first.id, harness.db);
    expect(mine.find((group) => group.field === "seo_meta_description")?.with.map((row) => row.title)).toEqual([
      "Cable B",
    ]);
  });

  it("counts a page with little on it as thin, and a shelf with no copy of its own", async () => {
    await listing({ title: "Sparse", status: "in_stock", description: "<p>Short.</p>" });
    const category = await shelf("Lighting");

    const report = await duplicateReport(harness.db);
    expect(report.thin.map((row) => row.title)).toContain("Sparse");
    expect(report.categoriesWithoutCopy.map((row) => row.id)).toContain(category.id);

    await updateCategory(staff, category.id, {
      name: category.name,
      slug: category.slug,
      seoMetaDescription: "Desk and floor lighting sourced from the US, landed price included.",
    });
    const after = await duplicateReport(harness.db);
    expect(after.categoriesWithoutCopy.map((row) => row.id)).not.toContain(category.id);
  });
});

describe("technical SEO", () => {
  it("reports why a page is not indexed, and what its canonical points at", async () => {
    const draft = await listing({ title: "Not Yet" });
    const audit = await listingTechnicalAudit(draft.id, harness.db);
    expect(audit?.indexable).toBe(false);
    expect(audit?.indexableReason).toMatch(/not public/);

    const live = await listing({ title: "Monitor Stand", status: "in_stock" });
    await updateProduct(staff, live.id, { canonicalUrl: "/products/something-else" });
    const second = await listingTechnicalAudit(live.id, harness.db);
    expect(second?.findings.map((finding) => finding.id)).toContain("canonical_elsewhere");
    expect(second?.findings.map((finding) => finding.id)).toContain("no_offer");
  });

  it("finds an old address that a live listing has taken over", async () => {
    const first = await listing({ title: "Cable", status: "in_stock" });
    await updateProduct(staff, first.id, { slug: "cable-braided" });
    const second = await listing({ title: "Cable" });
    expect(second.slug).toBe("cable");

    const audit = await listingTechnicalAudit(first.id, harness.db);
    expect(audit?.findings.some((finding) => finding.id.startsWith("shadowed_redirect"))).toBe(true);

    const health = await technicalHealth(harness.db);
    expect(health.shadowedRedirects.map((row) => row.fromSlug)).toContain("cable");
  });

  it("counts shelves that are empty, hidden, or have nothing written for them", async () => {
    const empty = await shelf("Empty Shelf");
    const filled = await shelf("Filled Shelf");
    const product = await listing({ title: "Thing", categoryId: filled.id, status: "in_stock" });
    await addVariant(staff, product.id, { options: [], priceBdt: 250_000, fulfillmentMode: "in_stock" });

    const before = await technicalHealth(harness.db);
    expect(before.emptyCategories.map((row) => row.id)).toContain(empty.id);
    expect(before.emptyCategories.map((row) => row.id)).not.toContain(filled.id);
    expect(before.categoriesWithoutMetadata).toBeGreaterThan(0);

    await updateCategory(staff, filled.id, { name: filled.name, slug: filled.slug, seoNoIndex: true });
    const after = await technicalHealth(harness.db);
    expect(after.hiddenCategories).toBe(1);
    // The listing is still indexable, but nothing indexed links to it.
    expect(after.onHiddenShelf).toBe(1);
    const audit = await listingTechnicalAudit(product.id, harness.db);
    expect(audit?.findings.map((finding) => finding.id)).toContain("shelf_hidden");
  });
});

describe("internal-link intelligence", () => {
  it("counts what nothing links to, and stops counting once a relationship exists", async () => {
    const hub = await listing({ title: "Turntable", status: "in_stock" });
    const accessory = await listing({ title: "Replacement Stylus", status: "in_stock" });

    const before = await linkIntelligence(harness.db);
    expect(before.orphanCount).toBe(2);

    await addRelationship(staff, {
      fromProductId: accessory.pkbProductId!,
      toProductId: hub.pkbProductId!,
      kind: "accessory_for",
    });

    const after = await linkIntelligence(harness.db);
    expect(after.orphanCount).toBe(0);
    expect(after.renderedLinks).toBe(1);
    expect(after.broken).toHaveLength(0);
  });

  it("reports an accepted relationship that leads nowhere a shopper can go", async () => {
    const hub = await listing({ title: "Camera", status: "in_stock" });
    const draft = await listing({ title: "Unreleased Grip" });
    await addRelationship(staff, {
      fromProductId: hub.pkbProductId!,
      toProductId: draft.pkbProductId!,
      kind: "accessory_for",
    });

    const intelligence = await linkIntelligence(harness.db);
    expect(intelligence.broken.map((row) => row.fromTitle)).toContain("Camera");
    expect(intelligence.broken[0].reason).toMatch(/not public/);
  });
});

describe("shelf SEO", () => {
  it("keeps what staff write, and refuses a canonical on another domain", async () => {
    const category = await shelf("Desks");
    await updateCategory(staff, category.id, {
      name: category.name,
      slug: category.slug,
      seoMetaTitle: "Standing desks, landed in Bangladesh",
      introHtml: "<p>Sit-stand desks we source to order.</p><script>alert(1)</script>",
    });

    const [row] = await harness.db.select().from(categories).where(eq(categories.id, category.id));
    expect(row.seoMetaTitle).toBe("Standing desks, landed in Bangladesh");
    // Staff HTML is reduced to the allow-list before storage (D-057).
    expect(row.introHtml).toBe("<p>Sit-stand desks we source to order.</p>");

    // A rename that does not mention the SEO fields leaves them alone.
    await updateCategory(staff, category.id, { name: "Desks & Tables", slug: category.slug });
    const [renamed] = await harness.db.select().from(categories).where(eq(categories.id, category.id));
    expect(renamed.seoMetaTitle).toBe("Standing desks, landed in Bangladesh");

    const foreign = categoryInputSchema.safeParse({
      name: "Desks",
      slug: "desks",
      canonicalUrl: "https://example.com/desks",
    });
    expect(foreign.success).toBe(false);
  });
});
