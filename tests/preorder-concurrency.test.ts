/**
 * The no-overselling rule, proven under real concurrency.
 *
 * The rest of the preorder tests run on PGlite, which serves one connection
 * and therefore cannot produce a race at all. This suite talks to the real
 * PostgreSQL server started by `npm run db:server`, on its own database, so
 * many reservations genuinely contend for the same row.
 *
 * If that server is not running the suite skips rather than passing quietly —
 * a race condition test that silently does not run is worse than none.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { productVariants } from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";
import {
  CapacityUnavailableError,
  reserveCapacityStandalone,
} from "@/lib/preorder";

const ADMIN_URL =
  process.env.CONCURRENCY_TEST_ADMIN_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const TEST_DB = "preorder_concurrency_test";
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

let client: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle> | undefined;
let variantId = "";
let productId = "";

async function serverIsReachable(): Promise<boolean> {
  const probe = postgres(ADMIN_URL, {
    max: 1,
    connect_timeout: 3,
    onnotice: () => {},
  });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * Probed at module load, not in beforeAll: skipIf is evaluated when the file
 * is collected, so deciding later would skip the real tests every time.
 */
const available = await serverIsReachable();

beforeAll(async () => {
  if (!available) return;

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB}`).catch(() => undefined);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();

  // Several connections, so reservations genuinely run at the same time.
  client = postgres(TEST_URL, { max: 20, onnotice: () => {} });
  db = drizzle(client, { schema });

  const migrationsDir = join(process.cwd(), "db/migrations");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.unsafe(trimmed);
    }
  }

  /**
   * Warm every connection before racing. Without this the pool creates
   * connections on demand, so the first reservation commits while the others
   * are still doing TCP setup — the suite then passes even with the row lock
   * removed, which is worse than having no test at all.
   */
  await Promise.all(
    Array.from({ length: 20 }, () => client!`select pg_sleep(0.05)`),
  );

  setDatabaseForTesting(db as unknown as Database);

  const [category] = await db
    .insert(schema.categories)
    .values({ name: "Audio", slug: "audio" })
    .returning({ id: schema.categories.id });

  const [product] = await db
    .insert(schema.products)
    .values({
      categoryId: category.id,
      title: "Contended Headphones",
      slug: "contended-headphones",
      status: "preorder_open",
    })
    .returning({ id: schema.products.id });

  productId = product.id;
}, 120_000);

afterAll(async () => {
  if (!available) return;
  setDatabaseForTesting(undefined);
  await client?.end({ timeout: 5 }).catch(() => undefined);

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB}`).catch(() => undefined);
  await admin.end();
}, 60_000);

/** Creates a fresh variant with the given capacity. */
async function freshVariant(capacity: number) {
  const [variant] = await db!
    .insert(productVariants)
    .values({
      productId,
      sku: `RACE-${Math.random().toString(36).slice(2, 10)}`,
      priceBdt: 100_00,
      fulfillmentMode: "preorder",
      preorderCapacity: capacity,
      preorderReserved: 0,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning({ id: productVariants.id });

  return variant.id;
}

async function reservedFor(id: string) {
  const [row] = await db!
    .select({ reserved: productVariants.preorderReserved })
    .from(productVariants)
    .where(eq(productVariants.id, id));
  return row.reserved;
}

beforeEach(async () => {
  if (!available) return;
  variantId = "";
});

describe.skipIf(!available)("preorder capacity under real concurrency", () => {
  /**
   * The headline rule from CLAUDE.md section 7: no overselling, no race on
   * the last slot.
   */
  it("sells the last slot exactly once when many shoppers race for it", async () => {
    variantId = await freshVariant(1);

    const attempts = 20;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        reserveCapacityStandalone(variantId, 1),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(attempts - 1);
    await expect(reservedFor(variantId)).resolves.toBe(1);

    // Every failure is a clean, explainable refusal, not a crash.
    for (const result of failed) {
      const reason = (result as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(CapacityUnavailableError);
    }
  }, 120_000);

  it("never reserves beyond capacity when demand far exceeds it", async () => {
    const capacity = 5;
    variantId = await freshVariant(capacity);

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => reserveCapacityStandalone(variantId, 1)),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    expect(succeeded).toBe(capacity);
    await expect(reservedFor(variantId)).resolves.toBe(capacity);
  }, 120_000);

  it("handles mixed quantities without exceeding capacity", async () => {
    const capacity = 10;
    variantId = await freshVariant(capacity);

    const quantities = [3, 4, 5, 2, 6, 1, 3, 4];
    const results = await Promise.allSettled(
      quantities.map((quantity) =>
        reserveCapacityStandalone(variantId, quantity),
      ),
    );

    const takenBySuccessful = quantities.filter(
      (_, index) => results[index].status === "fulfilled",
    );
    const total = takenBySuccessful.reduce((sum, q) => sum + q, 0);

    expect(total).toBeLessThanOrEqual(capacity);
    await expect(reservedFor(variantId)).resolves.toBe(total);
  }, 120_000);

  /**
   * What the row lock actually buys.
   *
   * Without it, the read-then-write window is wide open: many transactions
   * read the same remaining count and all try to increment. Overselling is
   * then stopped only by the database check constraint, so shoppers receive a
   * raw integrity error instead of a clean "that preorder is full". Measured
   * on this machine, removing the lock produced hundreds of such rejections
   * across these rounds; with the lock there are none.
   *
   * This test therefore asserts the shape of the failures, not just the count:
   * every refusal must be a CapacityUnavailableError.
   */
  it("refuses cleanly rather than hitting the database constraint", async () => {
    const rounds = 10;
    const attemptsPerRound = 30;

    for (let round = 0; round < rounds; round++) {
      const id = await freshVariant(1);

      const results = await Promise.allSettled(
        Array.from({ length: attemptsPerRound }, () =>
          reserveCapacityStandalone(id, 1),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded).toHaveLength(1);
      await expect(reservedFor(id)).resolves.toBe(1);

      for (const result of results) {
        if (result.status !== "rejected") continue;
        const reason = result.reason;
        expect(String(reason)).not.toMatch(/check constraint|violates/i);
        expect(reason).toBeInstanceOf(CapacityUnavailableError);
      }
    }
  }, 180_000);

  it("lets every shopper through when capacity is ample", async () => {
    variantId = await freshVariant(50);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserveCapacityStandalone(variantId, 1)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    await expect(reservedFor(variantId)).resolves.toBe(20);
  }, 120_000);

  /**
   * Releases run under the same lock, so a burst of cancellations cannot lose
   * a decrement or drive the count negative.
   */
  it("keeps the count correct when reservations and releases interleave", async () => {
    variantId = await freshVariant(30);

    await Promise.all(
      Array.from({ length: 10 }, () => reserveCapacityStandalone(variantId, 1)),
    );
    expect(await reservedFor(variantId)).toBe(10);

    const { releaseCapacityStandalone } = await import("@/lib/preorder");
    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        reserveCapacityStandalone(variantId, 1),
      ),
      ...Array.from({ length: 5 }, () =>
        releaseCapacityStandalone(variantId, 1),
      ),
    ]);

    await expect(reservedFor(variantId)).resolves.toBe(10);
  }, 120_000);
});

describe.skipIf(available)("preorder concurrency suite", () => {
  it("is skipped because no PostgreSQL server is reachable", () => {
    // Recorded rather than silently passing: run `npm run db:server` to
    // exercise the no-overselling rule under real concurrency.
    expect(available).toBe(false);
  });
});
