/**
 * Concurrent product saves on real PostgreSQL (finding F8).
 *
 * `updateProduct` accepts a partial patch and fills the rest of the row from
 * what it reads first. Until Stage 7 it read that row *before* taking the
 * knowledge lock, so two saves starting together both derived their write from
 * the same snapshot: the second one wrote back the first one's columns as they
 * had been, and recorded a "before" in the audit log and the SEO field history
 * that had already been replaced. The read now happens after the lock, inside
 * the transaction, so the saves queue behind one another.
 *
 * PGlite serves one connection and cannot produce this race, so this suite
 * needs the real server (`npm run db:server`) and skips loudly without it.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, products, seoFieldHistory, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateProduct } from "@/lib/catalog";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("product_save_concurrency_test", 12);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "saves@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "staff_admin" };
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

describe.skipIf(!available)("two staff saving the same listing at once", () => {
  it("keeps both changes: neither save writes the other's column back as it was", async () => {
    const category = await createCategory(staff, { name: "Saves", slug: "saves" });

    // Several rounds, because a race that happens to serialise once proves
    // nothing. Each round patches two disjoint fields from two callers.
    for (let round = 0; round < 6; round++) {
      const listing = await createProduct(staff, {
        title: `Original ${round}`,
        categoryId: category.id,
      });

      const results = await Promise.allSettled([
        updateProduct(staff, listing.id, { title: `Renamed ${round}` }),
        updateProduct(staff, listing.id, { brand: `Brandy ${round}` }),
      ]);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected.map((result) => (result as PromiseRejectedResult).reason)).toEqual([]);

      const [row] = await harness.db
        .select({ title: products.title, brand: products.brand, slug: products.slug })
        .from(products)
        .where(eq(products.id, listing.id));

      expect(row.title).toBe(`Renamed ${round}`);
      expect(row.brand).toBe(`Brandy ${round}`);
      // The address follows the title while the listing has never been public.
      expect(row.slug).toBe(`renamed-${round}`);
    }
  }, 180_000);

  it("records what the row actually was, so no two changes claim the same before", async () => {
    const category = await createCategory(staff, { name: "History", slug: "history" });
    const listing = await createProduct(staff, { title: "Chain start", categoryId: category.id });

    const names = ["Chain one", "Chain two", "Chain three", "Chain four"];
    const results = await Promise.allSettled(
      names.map((title) => updateProduct(staff, listing.id, { title })),
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);

    const rows = await harness.db
      .select({ before: seoFieldHistory.beforeValue, after: seoFieldHistory.afterValue })
      .from(seoFieldHistory)
      .where(and(eq(seoFieldHistory.productId, listing.id), eq(seoFieldHistory.field, "title")));

    const changes = rows.filter((row) => row.before !== row.after);
    expect(changes.length).toBeGreaterThan(0);

    // Each recorded change starts where some other change ended, or at the
    // original title. A stale read shows up as two changes with one "before".
    const befores = changes.map((row) => row.before);
    expect(new Set(befores).size).toBe(befores.length);
    const afters = new Set(changes.map((row) => row.after));
    for (const before of befores) {
      expect(before === "Chain start" || afters.has(before)).toBe(true);
    }

    // The audit log tells the same story for the same reason.
    const audits = await harness.db
      .select({ before: auditLog.beforeJson, after: auditLog.afterJson })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, listing.id), eq(auditLog.action, "product.updated")));
    const auditBefores = audits.map((row) => (row.before as { title?: string } | null)?.title);
    expect(new Set(auditBefores).size).toBe(auditBefores.length);
  }, 120_000);
});
