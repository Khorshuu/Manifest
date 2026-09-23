/**
 * Draining the search rebuild backlog on real PostgreSQL (risk R-12).
 *
 * Stage 6 rebuilt the whole catalogue inside the admin request that asked for
 * it. Stage 7 queues instead, and the queue's three claims — the work is
 * resumable, two workers do not do it twice, and a listing changed while the
 * rebuild drains is still rebuilt *after* its change — are all claims about
 * behaviour under concurrency.
 *
 * PGlite serves one connection and cannot produce any of those races, so this
 * suite needs the real server (`npm run db:server`) and skips loudly without
 * it.
 */
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productSearch, productSearchQueue, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { processSearchQueue, rebuildSearchIndex, searchIndexStatus } from "@/lib/search/maintenance";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;
let categoryId = "";

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("search_rebuild_concurrency_test", 12);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "rebuild@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "staff_admin" };
  const category = await createCategory(staff, { name: "Rebuild", slug: "rebuild" });
  categoryId = category.id;

  for (let index = 0; index < 24; index += 1) {
    await createProduct(staff, { title: `Listing ${index}`, categoryId });
  }
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

async function queuedCount() {
  const [row] = await harness.db.select({ n: sql<number>`count(*)::int` }).from(productSearchQueue);
  return Number(row?.n ?? 0);
}

describe.skipIf(!available)("draining the rebuild backlog", () => {
  it("queues the catalogue without rebuilding it, and the request does not wait for the work", async () => {
    await harness.db.delete(productSearchQueue);
    const report = await rebuildSearchIndex(staff);

    expect(report.products).toBe(24);
    expect(report.queued).toBe(24);
    // Still queued afterwards: the point of migration 0039 is that a row
    // queued as a `rebuild` is not rebuilt by the deferred trigger at this
    // commit, which is what used to put the whole catalogue inside one request.
    expect(await queuedCount()).toBe(24);
    const sources = await harness.db
      .selectDistinct({ source: productSearchQueue.source })
      .from(productSearchQueue);
    expect(sources).toEqual([{ source: "rebuild" }]);
  }, 120_000);

  it("is resumable: a bounded pass leaves the rest queued and the next pass finishes it", async () => {
    await harness.db.delete(productSearchQueue);
    await rebuildSearchIndex(staff);

    // One chunk's worth of budget. The rest must survive as queue rows, which
    // are the only progress record there is.
    const first = await processSearchQueue({ limit: 200, budgetMs: 1_000, continueWhenMore: false });
    expect(first.rebuilt).toBeGreaterThan(0);

    let guard = 0;
    while ((await queuedCount()) > 0 && guard < 20) {
      await processSearchQueue({ continueWhenMore: false });
      guard += 1;
    }
    expect(await queuedCount()).toBe(0);
    expect(await searchIndexStatus(staff)).toMatchObject({ missing: 0, queued: 0 });
  }, 120_000);

  it("lets four workers drain at once without rebuilding a listing twice", async () => {
    await harness.db.delete(productSearchQueue);
    await rebuildSearchIndex(staff);

    const reports = await Promise.all(
      Array.from({ length: 4 }, () => processSearchQueue({ continueWhenMore: false })),
    );

    // `for update skip locked` is what makes this true: without it every worker
    // reads the same oldest chunk and the total is a multiple of the catalogue.
    const rebuilt = reports.reduce((sum, report) => sum + report.rebuilt, 0);
    expect(rebuilt).toBe(24);
    expect(reports.reduce((sum, report) => sum + report.failed, 0)).toBe(0);
    expect(await queuedCount()).toBe(0);
  }, 120_000);

  it("rebuilds a listing changed mid-drain after the change, not before it", async () => {
    await harness.db.delete(productSearchQueue);
    await rebuildSearchIndex(staff);

    const [oldest] = await harness.db
      .select({ id: productSearchQueue.productId })
      .from(productSearchQueue)
      .orderBy(asc(productSearchQueue.queuedAt))
      .limit(1);

    // Drain everything, then change a listing: its own trigger queues it again
    // as a `change`, and that rebuild happens at its commit.
    await processSearchQueue({ continueWhenMore: false });
    expect(await queuedCount()).toBe(0);

    await harness.db
      .update(products)
      .set({ title: "Renamed while the rebuild ran", updatedAt: new Date() })
      .where(eq(products.id, oldest.id));

    const [indexed] = await harness.db
      .select({ titleNorm: productSearch.titleNorm })
      .from(productSearch)
      .where(eq(productSearch.productId, oldest.id));
    expect(indexed.titleNorm).toContain("renamed");
    // And nothing is left waiting: a change is rebuilt at its own commit, so it
    // never joins the backlog.
    expect(await queuedCount()).toBe(0);
  }, 120_000);

  it("keeps a listing queued, with its attempts counted, when the rebuild fails", async () => {
    await harness.db.delete(productSearchQueue);
    await rebuildSearchIndex(staff);

    // Break the rebuild for one pass, the way a bad migration or a missing
    // extension would. Nothing may be lost: the rows stay queued.
    await harness.db.execute(sql`alter function refresh_product_search(uuid[]) rename to refresh_product_search_ok`);
    await harness.db.execute(sql`
      create function refresh_product_search(uuid[]) returns void language plpgsql as $$
      begin raise exception 'index unavailable'; end $$
    `);

    const failed = await processSearchQueue({ continueWhenMore: false });
    expect(failed.rebuilt).toBe(0);
    expect(failed.failed).toBeGreaterThan(0);
    expect(failed.remaining).toBe(24);
    // A run that rebuilt nothing does not ask for a successor: a chunk that
    // always fails would otherwise re-enqueue for ever.
    expect(failed.continued).toBe(false);

    const [attempted] = await harness.db
      .select({ attempts: productSearchQueue.attempts })
      .from(productSearchQueue)
      .orderBy(asc(productSearchQueue.queuedAt))
      .limit(1);
    expect(attempted.attempts).toBe(1);

    await harness.db.execute(sql`drop function refresh_product_search(uuid[])`);
    await harness.db.execute(sql`alter function refresh_product_search_ok(uuid[]) rename to refresh_product_search`);

    // And it recovers by itself on the next pass, with nothing lost.
    await processSearchQueue({ continueWhenMore: false });
    expect(await queuedCount()).toBe(0);
    expect(await searchIndexStatus(staff)).toMatchObject({ missing: 0 });
  }, 120_000);
});

describe.skipIf(available)("search rebuild concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
