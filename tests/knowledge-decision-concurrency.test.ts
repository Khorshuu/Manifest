/**
 * Two people deciding one knowledge decision at the same moment, on real
 * PostgreSQL (Stage 8, D-110).
 *
 * `decideAlias` read the alias row *outside* its transaction and checked "this
 * one is still only suggested" against that read. Two decisions arriving
 * together both passed the check, and the second overwrote the first: an
 * approved alias — which is search vocabulary, and which nobody else had been
 * told about — could become rejected, or the other way round, attributed to
 * whoever committed last, with nothing on the row to say it had been decided
 * twice. It is the same shape as finding F8 on the listing save and the guard on
 * the SEO apply, both fixed in Stage 7: a check is only a check if the lock
 * comes first.
 *
 * Accepting claims is in here beside it as the control. That path already loads
 * its claims `for update`, so it should already be safe, and the point of
 * testing both together is that the safe one stays safe.
 *
 * PGlite serves one connection and cannot produce the race, so this needs the
 * real server (`npm run db:server`) and skips loudly without it.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pkbAliases, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { decideAlias, suggestAlias } from "@/lib/pkb/aliases";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;
let other: SessionUser;
let categoryId = "";

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("knowledge_decision_concurrency_test", 12);
  const rows = await harness.db
    .insert(users)
    .values([
      { email: "first@example.com", passwordHash: "x", role: "super_admin" },
      { email: "second@example.com", passwordHash: "x", role: "super_admin" },
    ])
    .returning({ id: users.id, email: users.email });
  staff = { id: rows[0].id, email: rows[0].email, role: "super_admin" };
  other = { id: rows[1].id, email: rows[1].email, role: "super_admin" };
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  categoryId = category.id;
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

async function suggestedAlias(round: number) {
  const listing = await createProduct(staff, { title: `Racing headphones ${round}`, categoryId });
  const [row] = await harness.db.select().from(products).where(eq(products.id, listing.id));
  return suggestAlias(staff, {
    target: { kind: "product", id: row.pkbProductId! },
    alias: `xm${round}`,
    aliasKind: "other",
  });
}

describe.skipIf(!available)("an approval and a rejection arriving together", () => {
  it("lets exactly one decide, and the other is told it is already decided", async () => {
    let refusals = 0;

    // Several rounds: a race that happens to serialise once proves nothing.
    for (let round = 0; round < 6; round += 1) {
      const alias = await suggestedAlias(round);

      const results = await Promise.allSettled([
        decideAlias(staff, alias.id, "approved"),
        decideAlias(other, alias.id, "rejected"),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBe(1);
      refusals += results.length - fulfilled.length;

      const [decided] = await harness.db.select().from(pkbAliases).where(eq(pkbAliases.id, alias.id));

      // One decision, one decider, and the two agree: the status is the one
      // whoever is recorded as deciding it actually asked for.
      expect(["approved", "rejected"]).toContain(decided.status);
      expect(decided.decidedBy).toBe(decided.status === "approved" ? staff.id : other.id);
      expect(decided.decidedAt).toBeTruthy();

      // Whichever was refused left no trace of itself on the row.
      const auditable = await harness.db
        .select()
        .from(pkbAliases)
        .where(and(eq(pkbAliases.id, alias.id), eq(pkbAliases.status, "suggested")));
      expect(auditable.length).toBe(0);
    }

    expect(refusals).toBe(6);
  }, 180_000);

  it("refuses a second decision that arrives after the first has committed", async () => {
    const alias = await suggestedAlias(99);
    await decideAlias(staff, alias.id, "approved");
    await expect(decideAlias(other, alias.id, "rejected")).rejects.toMatchObject({ status: 409 });

    const [decided] = await harness.db.select().from(pkbAliases).where(eq(pkbAliases.id, alias.id));
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe(staff.id);
  }, 60_000);
});
