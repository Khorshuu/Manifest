/**
 * Stage 4 of the knowledge platform: the SEO engine.
 *
 * Addresses that survive a rename (F5), a canonical that cannot point at
 * another domain (F6), structured data built from the knowledge base and the
 * page's own values (F7, F16), per-field SEO states with locks and history
 * (D-077, F9), the catalogue-wide health checks (D-081) and the internal links
 * drawn from accepted relationships (D-083).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  productImages,
  productSlugRedirects,
  products,
  seoFieldHistory,
  seoFieldStates,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  addVariant,
  createCategory,
  createProduct,
  stockState,
  updateProduct,
} from "@/lib/catalog";
import { addRelationship, backfillKnowledge } from "@/lib/pkb";
import { publishableKnowledge } from "@/lib/pkb/publish";
import { fieldStates, setFieldLock, recordFieldWrites, SeoFieldError } from "@/lib/seo/fields";
import { seoHealth } from "@/lib/seo/health";
import { knowledgeLinks } from "@/lib/seo/links";
import { resolveSlugRedirect, slugMayFollowTitle } from "@/lib/seo/redirects";
import { productSchema, type SeoOffer } from "@/lib/seo/structured-data";
import { productPatchSchema } from "@/lib/validation/catalog";
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

async function listing(input: { title: string; status?: string; brand?: string; description?: string }) {
  const category = await createCategory(staff, {
    name: "Audio",
    slug: `audio-${Math.random().toString(36).slice(2, 7)}`,
  });
  const product = await createProduct(staff, {
    title: input.title,
    categoryId: category.id,
    brand: input.brand,
    descriptionHtml: input.description ?? "<p>A description long enough to be worth reading.</p>",
  });
  if (input.status) {
    await harness.db.update(products).set({ status: input.status, firstPublishedAt: new Date() }).where(eq(products.id, product.id));
  }
  const [row] = await harness.db.select().from(products).where(eq(products.id, product.id));
  return { categoryId: category.id, product: row };
}

describe("addresses survive a rename", () => {
  it("keeps the address of a listing shoppers have seen, and follows the title while it is a draft", async () => {
    const draft = await listing({ title: "Working Title" });
    expect(slugMayFollowTitle(draft.product)).toBe(true);
    await updateProduct(staff, draft.product.id, { title: "Studio Headphones" });
    const [renamedDraft] = await harness.db.select().from(products).where(eq(products.id, draft.product.id));
    expect(renamedDraft.slug).toBe("studio-headphones");
    // The draft's first address is recorded too, so a shared preview link works.
    expect(await resolveSlugRedirect("working-title", harness.db)).toMatchObject({ slug: "studio-headphones" });

    const live = await listing({ title: "Reference Monitor", status: "in_stock" });
    expect(slugMayFollowTitle(live.product)).toBe(false);
    await updateProduct(staff, live.product.id, { title: "Reference Monitor Mk II" });
    const [renamedLive] = await harness.db.select().from(products).where(eq(products.id, live.product.id));
    expect(renamedLive.slug).toBe("reference-monitor");
  });

  it("records a redirect when staff change the address by hand", async () => {
    const live = await listing({ title: "Desk Lamp", status: "in_stock" });
    await updateProduct(staff, live.product.id, { slug: "desk-lamp-warm" });

    const moved = await resolveSlugRedirect("desk-lamp", harness.db);
    expect(moved).toMatchObject({ productId: live.product.id, slug: "desk-lamp-warm" });

    // Moving back removes the stale redirect rather than leaving a loop.
    await updateProduct(staff, live.product.id, { slug: "desk-lamp" });
    expect(await resolveSlugRedirect("desk-lamp", harness.db)).toBeNull();
    expect(await resolveSlugRedirect("desk-lamp-warm", harness.db)).toMatchObject({ slug: "desk-lamp" });
  });

  it("never lets a redirect shadow another listing's live address", async () => {
    const first = await listing({ title: "Cable", status: "in_stock" });
    await updateProduct(staff, first.product.id, { slug: "cable-braided" });
    // A second listing takes the freed address.
    const second = await listing({ title: "Cable" });
    expect(second.product.slug).toBe("cable");

    const rows = await harness.db.select().from(productSlugRedirects).where(eq(productSlugRedirects.fromSlug, "cable"));
    // The redirect exists but resolves to nothing, because the address is live.
    expect(rows).toHaveLength(1);
    const [liveOwner] = await harness.db.select().from(products).where(eq(products.slug, "cable"));
    expect(liveOwner.id).toBe(second.product.id);
  });
});

describe("canonical addresses", () => {
  it("accepts a path on this site and refuses another domain", () => {
    expect(productPatchSchema.safeParse({ canonicalUrl: "/products/example" }).success).toBe(true);
    expect(productPatchSchema.safeParse({ canonicalUrl: "" }).success).toBe(true);

    const foreign = productPatchSchema.safeParse({ canonicalUrl: "https://example.com/products/copy" });
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.error.issues[0].message).toMatch(/must stay on/);

    expect(productPatchSchema.safeParse({ canonicalUrl: "//evil.example/x" }).success).toBe(false);
    expect(productPatchSchema.safeParse({ canonicalUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("who decided each SEO field", () => {
  it("marks a staff save as theirs and keeps before and after", async () => {
    const { product } = await listing({ title: "Turntable" });
    await updateProduct(staff, product.id, { seoMetaTitle: "Turntable — belt drive, in Bangladesh" });

    const states = await fieldStates(harness.db, product.id);
    expect(states.get("seoMetaTitle")).toMatchObject({ state: "MANUAL", decidedBy: staff.id });

    const history = await harness.db
      .select()
      .from(seoFieldHistory)
      .where(and(eq(seoFieldHistory.productId, product.id), eq(seoFieldHistory.field, "seoMetaTitle")));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      beforeValue: null,
      afterValue: "Turntable — belt drive, in Bangladesh",
      afterState: "MANUAL",
      actorUserId: staff.id,
    });
  });

  it("refuses an automatic change to a locked field, and allows a person's", async () => {
    const { product } = await listing({ title: "Amplifier" });
    await updateProduct(staff, product.id, { seoMetaDescription: "A description the merchandiser wrote by hand." });
    const locked = await setFieldLock(staff, product.id, "seoMetaDescription", true, "Reviewed with the supplier.");
    expect(locked.state).toBe("LOCKED");

    // An accepted recommendation is automation: it is refused.
    await expect(
      harness.db.transaction((tx) =>
        recordFieldWrites(tx, product.id, staff.id, [
          {
            field: "seoMetaDescription",
            before: "A description the merchandiser wrote by hand.",
            after: "Generated wording",
            origin: "accepted",
            reason: "Applied from SEO Pulse",
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(SeoFieldError);

    // A person editing the field keeps it locked; nothing silently unlocks.
    await updateProduct(staff, product.id, { seoMetaDescription: "The merchandiser's own revision." });
    const states = await fieldStates(harness.db, product.id);
    expect(states.get("seoMetaDescription")?.state).toBe("LOCKED");

    await setFieldLock(staff, product.id, "seoMetaDescription", false);
    expect((await fieldStates(harness.db, product.id)).get("seoMetaDescription")?.state).toBe("MANUAL");
  });

  it("will not lock an empty field", async () => {
    const { product } = await listing({ title: "Speaker stand" });
    await expect(setFieldLock(staff, product.id, "seoMetaTitle", true)).rejects.toBeInstanceOf(SeoFieldError);
    expect(await harness.db.select().from(seoFieldStates).where(eq(seoFieldStates.productId, product.id))).toEqual([]);
  });
});

describe("structured data", () => {
  const offer = (over: Partial<SeoOffer> = {}): SeoOffer => ({
    variantId: "v1",
    pkbVariantId: null,
    label: "Standard",
    sku: "SKU-1",
    slug: "thing",
    priceBdt: 250_000,
    listPriceBdt: 250_000,
    saleEndsAt: null,
    fulfillmentMode: "in_stock",
    stockState: "in_stock",
    imageUrl: null,
    options: [],
    ...over,
  });

  const knowledge = { pkbProductId: "p", brand: null, identifiers: [], properties: [] };

  it("is a Product with one offer and a ProductGroup with several", () => {
    const single = productSchema({
      title: "Thing",
      slug: "thing",
      descriptionText: "What the page says.",
      legacyBrand: null,
      images: [{ url: "/a.jpg", altText: "A thing" }],
      offers: [offer()],
      rating: { average: null, count: 0 },
      knowledge,
      canonicalPath: null,
    });
    expect(single["@type"]).toBe("Product");
    expect(single.description).toBe("What the page says.");
    expect((single.offers as Record<string, unknown>).price).toBe("2500.00");
    expect(single.aggregateRating).toBeUndefined();

    const group = productSchema({
      title: "Thing",
      slug: "thing",
      descriptionText: null,
      legacyBrand: "Harbor",
      images: [],
      offers: [
        offer({ variantId: "v1", label: "256 GB", options: [{ attribute: "Storage", value: "256 GB" }] }),
        offer({
          variantId: "v2",
          label: "512 GB",
          priceBdt: 300_000,
          stockState: "out_of_stock",
          options: [{ attribute: "Storage", value: "512 GB" }],
        }),
      ],
      rating: { average: 4.5, count: 2 },
      knowledge,
      canonicalPath: null,
    });
    expect(group["@type"]).toBe("ProductGroup");
    expect(group.variesBy).toEqual(["Storage"]);
    const variants = group.hasVariant as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    // Each offer states its own price and its own availability (finding F16).
    expect((variants[0].offers as Record<string, unknown>).availability).toBe("https://schema.org/InStock");
    expect((variants[1].offers as Record<string, unknown>).availability).toBe("https://schema.org/OutOfStock");
    expect((variants[1].offers as Record<string, unknown>).price).toBe("3000.00");
    expect(group.aggregateRating).toMatchObject({ ratingValue: 4.5, reviewCount: 2 });
  });

  it("uses the availability the page shows, preorder included", () => {
    const state = stockState({
      fulfillmentMode: "preorder",
      stockQuantity: null,
      lowStockThreshold: null,
      preorderCapacity: 10,
      preorderReserved: 3,
      isClosed: false,
    });
    const schema = productSchema({
      title: "Preorder",
      slug: "preorder",
      descriptionText: null,
      legacyBrand: null,
      images: [],
      offers: [offer({ fulfillmentMode: "preorder", stockState: state })],
      rating: { average: null, count: 0 },
      knowledge,
      canonicalPath: null,
    });
    expect((schema.offers as Record<string, unknown>).availability).toBe("https://schema.org/PreOrder");
  });

  it("publishes a staff-entered identifier but not an unchecked legacy one", async () => {
    /*
     * A listing imported from before the knowledge base existed: its values are
     * LEGACY, of unknown origin, so nothing about it is told to a search engine
     * (invariant I-11).
     */
    const category = await createCategory(staff, { name: "Imported", slug: `imported-${Math.random().toString(36).slice(2, 7)}` });
    const [legacy] = await harness.db
      .insert(products)
      .values({
        categoryId: category.id,
        title: "Imported Headphones",
        slug: "imported-headphones",
        brand: "Harbor Acoustics",
        identifierType: "gtin",
        identifierValue: "4006381333931",
        status: "in_stock",
        firstPublishedAt: new Date(),
      })
      .returning();
    await backfillKnowledge();
    const [imported] = await harness.db.select().from(products).where(eq(products.id, legacy.id));

    const before = await publishableKnowledge(imported.pkbProductId, harness.db);
    expect(before.identifiers).toEqual([]);
    expect(before.brand).toBeNull();

    /*
     * A staff save is a decision, and a decided value is publishable. The
     * mirror credits a save only with what it changes (D-070), so the values
     * are corrected here rather than re-saved unchanged.
     */
    await updateProduct(staff, imported.id, { identifierType: "gtin", identifierValue: "5012345678900", brand: "Harbor Acoustics Ltd" });
    const [listingRow] = await harness.db.select().from(products).where(eq(products.id, legacy.id));
    const after = await publishableKnowledge(listingRow.pkbProductId, harness.db);
    expect(after.brand).toBe("Harbor Acoustics Ltd");
    expect(after.identifiers.map((row) => row.value)).toContain("5012345678900");

    const schema = productSchema({
      title: listingRow.title,
      slug: listingRow.slug,
      descriptionText: "Visible copy.",
      legacyBrand: listingRow.brand,
      images: [],
      offers: [offer()],
      rating: { average: null, count: 0 },
      knowledge: after,
      canonicalPath: null,
    });
    expect(schema.gtin).toBe("5012345678900");
    expect(schema.brand).toMatchObject({ name: "Harbor Acoustics Ltd" });
  });
});

describe("internal links", () => {
  it("links only accepted relationships to listings a shopper can reach", async () => {
    const hub = await listing({ title: "Turntable", status: "in_stock" });
    const accessory = await listing({ title: "Replacement Stylus", status: "in_stock" });
    const draft = await listing({ title: "Unreleased Mat" });

    await addRelationship(staff, {
      fromProductId: accessory.product.pkbProductId!,
      toProductId: hub.product.pkbProductId!,
      kind: "accessory_for",
    });
    await addRelationship(staff, {
      fromProductId: draft.product.pkbProductId!,
      toProductId: hub.product.pkbProductId!,
      kind: "accessory_for",
    });

    const groups = await knowledgeLinks(hub.product.pkbProductId, {}, harness.db);
    const titles = groups.flatMap((group) => group.products.map((product) => product.title));
    expect(titles).toContain("Replacement Stylus");
    // The draft has no public page: linking to it would be a dead end.
    expect(titles).not.toContain("Unreleased Mat");
  });

  it("returns nothing when the knowledge base records no relationship", async () => {
    const alone = await listing({ title: "Lonely Product", status: "in_stock" });
    expect(await knowledgeLinks(alone.product.pkbProductId, {}, harness.db)).toEqual([]);
  });
});

describe("catalogue health", () => {
  it("counts real failures and names examples", async () => {
    const thin = await listing({ title: "Thin Listing", status: "in_stock", description: "<p>Too short.</p>" });
    await addVariant(staff, thin.product.id, { priceBdt: 100_00, fulfillmentMode: "in_stock", stockQuantity: 5 } as never);

    const health = await seoHealth(staff, harness.db);
    expect(health.publishedListings).toBe(1);
    expect(health.indexableListings).toBe(1);

    const description = health.issues.find((issue) => issue.id === "thin_description");
    expect(description).toMatchObject({ count: 1, severity: "required" });
    expect(description!.examples[0]).toMatchObject({ id: thin.product.id });
    expect(description!.examples[0].detail).toMatch(/characters/);

    // A listing hidden from search is not counted as indexable.
    await updateProduct(staff, thin.product.id, { seoNoIndex: true });
    const hidden = await seoHealth(staff, harness.db);
    expect(hidden.indexableListings).toBe(0);
    expect(hidden.issues.find((issue) => issue.id === "thin_description")).toBeUndefined();
  });

  it("reports a photograph nobody has described", async () => {
    const { product } = await listing({ title: "Undescribed", status: "in_stock" });
    await harness.db.insert(productImages).values({
      productId: product.id,
      url: "/uploads/a.jpg",
      altText: "a.jpg",
      kind: "gallery",
      sortOrder: 0,
    });
    const health = await seoHealth(staff, harness.db);
    const issue = health.issues.find((entry) => entry.id === "thin_image_alt");
    expect(issue?.count).toBe(1);
    expect(issue?.examples[0].detail).toBe("1 of 1");
  });
});
