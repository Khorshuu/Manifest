/**
 * The media registry and sweep (lib/media/registry.ts, D-055): every upload
 * is recorded, and a file is deleted only once nothing points at it and the
 * grace period has passed. A file an old order still shows is never deleted.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  categories,
  mediaObjects,
  orderItems,
  orders,
  productImages,
  products,
  productVariants,
  siteSettings,
  users,
  variantImages,
} from "@/db/schema";
import {
  mediaCoverage,
  registerExistingMedia,
  sweepUnreferencedMedia,
  withMediaRegistry,
} from "@/lib/media/registry";
import type { MediaProvider, StoredMedia } from "@/lib/providers/media";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

/** Stores nothing; records what it was asked to delete. */
class FakeProvider implements MediaProvider {
  readonly deleted: string[] = [];
  failDeletes = false;
  private count = 0;

  constructor(readonly name = "fake") {}

  async upload(): Promise<StoredMedia> {
    this.count += 1;
    const key = `file-${this.count}.webp`;
    return { key, url: `/uploads/${key}`, contentType: "image/webp", bytes: 10, width: 4, height: 5, sha256: "ab" };
  }

  async delete(key: string) {
    if (this.failDeletes) throw new Error("storage unavailable");
    this.deleted.push(key);
  }
}

const DAY = 86_400_000;
const now = new Date();

async function registered(provider: MediaProvider, ageMs: number, name = "fake") {
  const key = `${Math.random().toString(36).slice(2)}.webp`;
  const url = `/uploads/${key}`;
  await harness.db.insert(mediaObjects).values({
    key,
    provider: name,
    url,
    contentType: "image/webp",
    bytes: 10,
    createdAt: new Date(now.getTime() - ageMs),
  });
  return { key, url };
}

let productId = "";
let variantId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [category] = await harness.db.insert(categories).values({ name: "C", slug: "c" }).returning();
  const [product] = await harness.db
    .insert(products)
    .values({ categoryId: category.id, title: "P", slug: "p", status: "preorder_open" })
    .returning();
  const [variant] = await harness.db
    .insert(productVariants)
    .values({ productId: product.id, sku: "P-1", priceBdt: 100_00, fulfillmentMode: "preorder" })
    .returning();
  productId = product.id;
  variantId = variant.id;
});

describe("recording uploads", () => {
  it("records each stored file with its size", async () => {
    const provider = withMediaRegistry(new FakeProvider());
    const stored = await provider.upload({ data: Buffer.alloc(1), originalName: "a.png", contentType: "image/png" });
    const [row] = await harness.db.select().from(mediaObjects).where(eq(mediaObjects.key, stored.key));
    expect(row).toMatchObject({ provider: "fake", url: stored.url, bytes: 10, width: 4, height: 5 });
  });

  it("deletes the file again if it cannot be recorded", async () => {
    const inner = new FakeProvider();
    const provider = withMediaRegistry(inner);
    const first = await provider.upload({ data: Buffer.alloc(1), originalName: "a.png", contentType: "image/png" });
    // Same key again: the insert fails on the primary key.
    await harness.db.update(mediaObjects).set({ key: "file-2.webp" }).where(eq(mediaObjects.key, first.key));
    await expect(
      provider.upload({ data: Buffer.alloc(1), originalName: "b.png", contentType: "image/png" }),
    ).rejects.toThrow();
    expect(inner.deleted).toEqual(["file-2.webp"]);
  });
});

describe("sweeping unreferenced files", () => {
  it("deletes an old file nothing points at, and its row", async () => {
    const provider = new FakeProvider();
    const orphan = await registered(provider, 2 * DAY);
    const report = await sweepUnreferencedMedia(provider, { now });
    expect(report).toEqual({ examined: 1, deleted: 1, failed: 0 });
    expect(provider.deleted).toEqual([orphan.key]);
    expect(await harness.db.select().from(mediaObjects)).toHaveLength(0);
  });

  it("keeps a file younger than the grace period", async () => {
    const provider = new FakeProvider();
    await registered(provider, 60_000);
    expect((await sweepUnreferencedMedia(provider, { now })).deleted).toBe(0);
  });

  it("keeps files a product image, a variant image or a homepage setting shows", async () => {
    const provider = new FakeProvider();
    const product = await registered(provider, 2 * DAY);
    const variant = await registered(provider, 2 * DAY);
    const hero = await registered(provider, 2 * DAY);
    await harness.db.insert(productImages).values({ productId, url: product.url, altText: "A" });
    await harness.db.insert(variantImages).values({ variantId, url: variant.url, altText: "B" });
    await harness.db
      .insert(siteSettings)
      .values({ key: "home.hero", valueJson: { imageUrl: hero.url, imageKey: hero.key } });

    expect(await sweepUnreferencedMedia(provider, { now })).toEqual({ examined: 0, deleted: 0, failed: 0 });
    expect(provider.deleted).toEqual([]);
  });

  /** The defect this replaced: removing a photograph blanked old orders. */
  it("keeps a file an order line still shows after the product image is gone", async () => {
    const provider = new FakeProvider();
    const photo = await registered(provider, 2 * DAY);
    const [user] = await harness.db.insert(users).values({ email: "b@example.com", passwordHash: "x" }).returning();
    const [address] = await harness.db
      .insert(addresses)
      .values({ userId: user.id, recipientName: "B", phone: "+8801700000000", addressLine1: "1", city: "Dhaka", district: "Dhaka" })
      .returning();
    const [order] = await harness.db
      .insert(orders)
      .values({
        orderNumber: "ORD-2026-000001",
        userId: user.id,
        status: "delivered",
        shippingAddressId: address.id,
        subtotalBdt: 100_00,
        totalBdt: 100_00,
        amountDueNowBdt: 100_00,
        idempotencyKey: "sweep-1",
      })
      .returning();
    await harness.db.insert(orderItems).values({
      orderId: order.id,
      variantId,
      titleSnapshot: "P",
      unitPriceBdt: 100_00,
      quantity: 1,
      fulfillmentModeSnapshot: "preorder",
      imageUrlSnapshot: photo.url,
    });

    expect((await sweepUnreferencedMedia(provider, { now })).deleted).toBe(0);
    expect(provider.deleted).toEqual([]);
  });

  it("leaves files stored by a different provider", async () => {
    const provider = new FakeProvider();
    await registered(provider, 2 * DAY, "blob");
    expect((await sweepUnreferencedMedia(provider, { now })).examined).toBe(0);
  });

  it("puts the row back when storage refuses the delete, so the next sweep retries", async () => {
    const provider = new FakeProvider();
    const orphan = await registered(provider, 2 * DAY);
    provider.failDeletes = true;
    expect(await sweepUnreferencedMedia(provider, { now })).toEqual({ examined: 1, deleted: 0, failed: 1 });
    expect(await harness.db.select().from(mediaObjects).where(eq(mediaObjects.key, orphan.key))).toHaveLength(1);

    provider.failDeletes = false;
    expect((await sweepUnreferencedMedia(provider, { now })).deleted).toBe(1);
  });

  it("deletes each file once when two sweeps run together", async () => {
    const provider = new FakeProvider();
    for (let index = 0; index < 5; index += 1) await registered(provider, 2 * DAY);
    const reports = await Promise.all([
      sweepUnreferencedMedia(provider, { now }),
      sweepUnreferencedMedia(provider, { now }),
    ]);
    expect(reports[0].deleted + reports[1].deleted).toBe(5);
    expect(new Set(provider.deleted).size).toBe(5);
    expect(provider.deleted).toHaveLength(5);
  });
});

/*
 * Risk R-11. A freshly seeded shop has no registry rows at all, and that is
 * correct rather than broken: the seed's illustrations are files committed to
 * `public/`, and a registry row is what makes the sweep willing to delete a
 * file. What must not happen is either half of the opposite mistake — a file
 * this provider stores going unrecorded, so nothing can ever reclaim it, or a
 * file the site ships gaining a row and becoming deletable.
 */
describe("what the registry knows about", () => {
  /** A provider that owns `/uploads/…` and nothing else. */
  class OwningProvider extends FakeProvider {
    keyFor(url: string): string | null {
      const prefix = "/uploads/";
      if (!url.startsWith(prefix)) return null;
      const key = url.slice(prefix.length);
      return key && !key.includes("/") ? key : null;
    }
  }

  it("separates a file it stores from one the site ships with", async () => {
    const provider = new OwningProvider();
    await harness.db.insert(productImages).values([
      // Shipped with the site: no row, and none should be invented.
      { productId, url: "/seed/headphones.svg", altText: "Shipped illustration", sortOrder: 0 },
      // Stored by this provider, but never recorded.
      { productId, url: "/uploads/orphan.webp", altText: "An orphan", sortOrder: 1 },
    ]);
    const recorded = await registered(provider, 0);
    await harness.db.insert(variantImages).values({ variantId, url: recorded.url, altText: "Recorded", sortOrder: 0 });

    const coverage = await mediaCoverage(provider, harness.db);
    expect(coverage.referenced).toBe(3);
    expect(coverage.registered).toBe(1);
    expect(coverage.unregisteredOwned).toBe(1);
    expect(coverage.foreignOrStatic).toBe(1);
    expect(coverage.samples).toEqual(["/uploads/orphan.webp"]);
  });

  it("registers only the files it stores, records no measurement it cannot make, and repeats safely", async () => {
    const provider = new OwningProvider();
    await harness.db.insert(productImages).values([
      { productId, url: "/seed/headphones.svg", altText: "Shipped illustration", sortOrder: 0 },
      { productId, url: "/uploads/orphan.webp", altText: "An orphan", sortOrder: 1 },
    ]);

    const first = await registerExistingMedia(provider, { executor: harness.db });
    expect(first.registered).toBe(1);

    const rows = await harness.db.select().from(mediaObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "/uploads/orphan.webp", key: "orphan.webp", provider: "fake" });
    // Unknown, not invented. Every report distinguishes the two.
    expect(rows[0].width).toBeNull();
    expect(rows[0].height).toBeNull();
    expect(rows[0].sha256).toBeNull();

    // The shipped file is still unknown to the registry, so the sweep can
    // never delete it.
    expect(rows.some((row) => row.url.startsWith("/seed/"))).toBe(false);

    const second = await registerExistingMedia(provider, { executor: harness.db });
    expect(second.registered).toBe(0);
    expect(await harness.db.select().from(mediaObjects)).toHaveLength(1);

    const coverage = await mediaCoverage(provider, harness.db);
    expect(coverage.unregisteredOwned).toBe(0);
    expect(coverage.registeredWithoutDimensions).toBe(1);
  });

  it("measures what it records, from the file rather than from its name", async () => {
    // A real one-pixel PNG, deliberately not named .png: if anything read the
    // extension instead of the bytes it would record the wrong format, and the
    // dimensions would have to be invented.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAADwyuo0AAAAFklEQVR4nGP8z4AATAxQxhArQgAAAP//G3EBaQyGb6gAAAAASUVORK5CYII=",
      "base64",
    );
    class ReadableProvider extends FakeProvider {
      keyFor(url: string): string | null {
        return url.startsWith("/uploads/") ? url.slice("/uploads/".length) : null;
      }
      async read(): Promise<Buffer | null> {
        return png;
      }
    }

    await harness.db
      .insert(productImages)
      .values({ productId, url: "/uploads/mystery.webp", altText: "Mystery", sortOrder: 0 });

    const report = await registerExistingMedia(new ReadableProvider(), { executor: harness.db });
    expect(report).toMatchObject({ registered: 1, measured: 1 });

    const [row] = await harness.db.select().from(mediaObjects);
    expect(row).toMatchObject({ width: 3, height: 2, contentType: "image/png", bytes: png.length });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Not "image/webp", which is the only thing the address ever claimed.
    expect(row.contentType).not.toBe("image/webp");
  });

  it("records a file it cannot read back, with its measurements left unknown", async () => {
    class UnreadableProvider extends FakeProvider {
      keyFor(url: string): string | null {
        return url.startsWith("/uploads/") ? url.slice("/uploads/".length) : null;
      }
      async read(): Promise<Buffer | null> {
        return null;
      }
    }

    await harness.db
      .insert(productImages)
      .values({ productId, url: "/uploads/gone.webp", altText: "Gone", sortOrder: 0 });

    expect(await registerExistingMedia(new UnreadableProvider(), { executor: harness.db })).toMatchObject({
      registered: 1,
      measured: 0,
    });
    const [row] = await harness.db.select().from(mediaObjects);
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    // Recorded all the same, because a file nothing records is a file the sweep
    // can never reclaim — which is the whole of R-11.
    expect(row.url).toBe("/uploads/gone.webp");
  });

  it("cannot delete in the same run what it has just registered", async () => {
    class OwningProvider extends FakeProvider {
      keyFor(url: string): string | null {
        return url.startsWith("/uploads/") ? url.slice("/uploads/".length) : null;
      }
    }
    const provider = new OwningProvider();

    await harness.db
      .insert(productImages)
      .values({ productId, url: "/uploads/fresh.webp", altText: "Fresh", sortOrder: 0 });
    await registerExistingMedia(provider, { executor: harness.db });

    // The row is minutes old and the file is still shown, so the sweep has two
    // separate reasons to leave it alone. Either one failing would mean the
    // reconciliation had made a photograph deletable.
    expect(await sweepUnreferencedMedia(provider)).toMatchObject({ deleted: 0 });
    expect(provider.deleted).toHaveLength(0);
    expect(await harness.db.select().from(mediaObjects)).toHaveLength(1);
  });

  it("does nothing for a provider that cannot say what it owns", async () => {
    const provider = new FakeProvider();
    await harness.db.insert(productImages).values({ productId, url: "/uploads/unknowable.webp", altText: "Unknowable", sortOrder: 0 });
    const coverage = await mediaCoverage(provider, harness.db);
    expect(coverage.unregisteredOwned).toBe(0);
    expect(coverage.foreignOrStatic).toBe(1);
    // Passed over rather than recorded: a provider that cannot say what it
    // stores must not have rows written on its behalf.
    expect(await registerExistingMedia(provider, { executor: harness.db })).toEqual({
      registered: 0,
      skipped: 1,
      measured: 0,
    });
    expect(await harness.db.select().from(mediaObjects)).toHaveLength(0);
  });
});
