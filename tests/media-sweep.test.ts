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
import { sweepUnreferencedMedia, withMediaRegistry } from "@/lib/media/registry";
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
