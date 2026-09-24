/**
 * Pruning old rows in bounded batches (Stage 8, D-111).
 *
 * The maintenance job's prunes used to be one statement each: delete everything
 * past the retention window, and ask for an identifier back for every row
 * deleted, only ever to count them. Both halves are unbounded — the transaction
 * and the array — and how much there is to delete is decided by traffic, or by
 * Google, rather than by the catalogue. Pruning 500,000 Search Console
 * measurements on the bench database took 2,177 ms and added 106 MB of live
 * identifiers to the heap.
 *
 * These tests hold the two properties that matter: the count is still exact,
 * and the work is done in batches whose size does not depend on how much there
 * is to do.
 */
import { lt, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimitHits } from "@/db/schema";
import { queryRows } from "@/lib/pkb/common";
import { pruneInBatches } from "@/lib/prune";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const OLD = new Date("2020-01-01T00:00:00.000Z");
const RECENT = new Date("2030-01-01T00:00:00.000Z");
const CUTOFF = new Date("2025-01-01T00:00:00.000Z");

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

/** `rate_limit_hits` is the simplest table with a timestamp to prune on. */
async function seed(old: number, recent: number) {
  const rows: (typeof rateLimitHits.$inferInsert)[] = [];
  for (let index = 0; index < old; index += 1) {
    rows.push({ key: `old-${index}`, windowStart: OLD, count: 1 });
  }
  for (let index = 0; index < recent; index += 1) {
    rows.push({ key: `new-${index}`, windowStart: RECENT, count: 1 });
  }
  for (let at = 0; at < rows.length; at += 500) {
    await harness.db.insert(rateLimitHits).values(rows.slice(at, at + 500));
  }
}

async function remaining() {
  const [row] = await queryRows<{ n: number }>(harness.db, sql`select count(*)::int as n from rate_limit_hits`);
  return row.n;
}

describe("a batched prune", () => {
  it("removes exactly what is past the cutoff, and counts it exactly", async () => {
    await seed(250, 40);

    const result = await pruneInBatches(rateLimitHits, lt(rateLimitHits.windowStart, CUTOFF), { batch: 100 });

    expect(result.removed).toBe(250);
    expect(result.more).toBe(false);
    expect(await remaining()).toBe(40);
  });

  it("stops at its ceiling and says there is more, rather than running on", async () => {
    await seed(250, 10);

    // Two passes of a hundred: 200 rows go, 50 are left, and the caller is told.
    const first = await pruneInBatches(rateLimitHits, lt(rateLimitHits.windowStart, CUTOFF), {
      batch: 100,
      maxBatches: 2,
    });
    expect(first.removed).toBe(200);
    expect(first.more).toBe(true);
    expect(await remaining()).toBe(60);

    const second = await pruneInBatches(rateLimitHits, lt(rateLimitHits.windowStart, CUTOFF), {
      batch: 100,
      maxBatches: 2,
    });
    expect(second.removed).toBe(50);
    expect(second.more).toBe(false);
    expect(await remaining()).toBe(10);
  });

  it("does nothing, and says so, when there is nothing past the cutoff", async () => {
    await seed(0, 12);
    const result = await pruneInBatches(rateLimitHits, lt(rateLimitHits.windowStart, CUTOFF), { batch: 100 });
    expect(result).toEqual({ removed: 0, more: false });
    expect(await remaining()).toBe(12);
  });

  it("keeps its batch size within the bounds it documents", async () => {
    await seed(120, 0);

    // A batch below the floor is raised to it, so a caller cannot ask for a
    // prune that issues one statement per row.
    const result = await pruneInBatches(rateLimitHits, lt(rateLimitHits.windowStart, CUTOFF), {
      batch: 1,
      maxBatches: 1,
    });
    expect(result.removed).toBe(100);
    expect(result.more).toBe(true);
  });
});
