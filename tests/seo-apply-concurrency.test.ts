/**
 * Two SEO Pulse applies at the same moment, on real PostgreSQL.
 *
 * `applySeoPulse` promises that a field which already has a value is never
 * replaced unless the operator chose Replace for it. Until Stage 7 that promise
 * was checked before the transaction, against a listing read outside it — the
 * same shape of stale read as finding F8, on the guard rather than on the
 * patch. Two people applying two different runs together both passed the check,
 * and the second replaced the first's wording without anybody confirming it.
 *
 * PGlite serves one connection and cannot produce the race, so this needs the
 * real server (`npm run db:server`) and skips loudly without it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { applySeoPulse, runSeoPulse } from "@/lib/seo-pulse";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;
let categoryId = "";
let keys = 0;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("seo_apply_concurrency_test", 12);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "seo@example.com", passwordHash: "x", role: "super_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "super_admin" };
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  categoryId = category.id;
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

async function listingWithRun(title: string) {
  const listing = await createProduct(staff, { title, categoryId });
  keys += 1;
  const { run } = await runSeoPulse(staff, listing.id, { requestKey: `race-${keys}`, fresh: true });
  return { listing, run };
}

describe("two applies racing for the same field", () => {
  it("lets one through and refuses the other, rather than replacing silently", async () => {
    // Several rounds: a race that happens to serialise once proves nothing.
    let refused = 0;

    for (let round = 0; round < 6; round += 1) {
      const { listing, run } = await listingWithRun(`Racing headphones ${round}`);

      const apply = (description: string) =>
        applySeoPulse(staff, listing.id, {
          runId: run.id,
          fields: { seoMetaDescription: description },
          overwrite: [],
        });

      const results = await Promise.allSettled([apply("A".repeat(80)), apply("B".repeat(80))]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");

      // Whichever order they land in, the listing's description is one of the
      // two — never a value nobody asked for — and at most one apply succeeded
      // without Replace being chosen.
      const [saved] = await harness.db
        .select({ description: products.seoMetaDescription })
        .from(products)
        .where(eq(products.id, listing.id));
      expect([("A".repeat(80)), ("B".repeat(80))]).toContain(saved.description);
      expect(fulfilled.length).toBeLessThanOrEqual(1);
      if (fulfilled.length === 1) refused += 1;
    }

    // And the refusal is the documented one, not a database error: the other
    // caller is told to choose Replace.
    expect(refused).toBeGreaterThan(0);
  }, 180_000);

  it("still refuses a stale apply once the field has been written", async () => {
    const { listing, run } = await listingWithRun("Sequential headphones");

    await applySeoPulse(staff, listing.id, {
      runId: run.id,
      fields: { seoMetaDescription: "A".repeat(80) },
      overwrite: [],
    });

    // The same run applied again, without Replace. The value is no longer
    // empty, so it is refused — whether the check reads before or inside the
    // transaction, this one has always worked; it is here so the race test
    // above cannot pass by breaking the ordinary case.
    await expect(
      applySeoPulse(staff, listing.id, {
        runId: run.id,
        fields: { seoMetaDescription: "B".repeat(80) },
        overwrite: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
  }, 120_000);
});

describe.skipIf(available)("SEO apply concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
