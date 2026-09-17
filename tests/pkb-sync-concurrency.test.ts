/**
 * The knowledge mirror under real concurrency (PostgreSQL, not PGlite): staff
 * saves, writes that bypass lib/, and several queue workers on the same
 * listings at once. No deadlock, no duplicate values, and a clean
 * reconciliation once the queue drains.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pkbFacts, pkbSyncQueue, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { knowledgeReport, processKnowledgeQueue } from "@/lib/pkb";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("pkb_sync_concurrency_test", 24);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "pkb@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "staff_admin" };
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

describe.skipIf(!available)("mirroring listings while everything writes at once", () => {
  it("never deadlocks, never duplicates a value, and reconciles when the queue drains", async () => {
    const category = await createCategory(staff, { name: "Race", slug: "race" });
    const listings = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createProduct(staff, { title: `Race listing ${index}`, categoryId: category.id, details: { material: "Oak" } }),
      ),
    );

    const failures: unknown[] = [];
    const record = (promise: Promise<unknown>) =>
      promise.catch((error) => {
        failures.push(error);
      });

    for (let round = 0; round < 4; round++) {
      await Promise.all([
        // Staff saves on every listing.
        ...listings.map((listing, index) =>
          record(updateProduct(staff, listing.id, { details: { material: `Staff ${round}-${index}`, color: "Black" } })),
        ),
        // A script writing the same listings behind lib/'s back.
        ...listings.map((listing, index) =>
          record(
            harness.db
              .update(products)
              .set({ brand: `Script ${round}-${index}` })
              .where(eq(products.id, listing.id)),
          ),
        ),
        // Several workers draining the queue at the same moment.
        ...Array.from({ length: 4 }, (_, worker) =>
          record(processKnowledgeQueue(harness.db, { limit: 20, workerId: `worker-${round}-${worker}` })),
        ),
      ]);
    }

    expect(failures).toEqual([]);

    for (let pass = 0; pass < 5; pass++) {
      const report = await processKnowledgeQueue(harness.db, { limit: 100 });
      expect(report.failed).toBe(0);
      if (report.remaining === 0) break;
    }
    const [{ queued }] = await harness.db.select({ queued: sql<number>`count(*)::int` }).from(pkbSyncQueue);
    expect(Number(queued)).toBe(0);

    const duplicates = await harness.db.execute(sql`
      select pkb_product_id, pkb_variant_id, definition_id, ordinal, count(*) from ${pkbFacts}
      group by 1, 2, 3, 4 having count(*) > 1
    `);
    expect(Array.isArray(duplicates) ? duplicates : []).toEqual([]);

    const report = await knowledgeReport(harness.db);
    expect(report.projectionMismatches).toEqual([]);
    expect(report.ok).toBe(true);
  }, 180_000);
});
