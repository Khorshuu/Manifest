/**
 * D-127 under real concurrency, on the PostgreSQL server: the local-AI slot
 * holds across connections (another Node process is another connection), a
 * dead holder cannot keep it, and the final check before local wording is
 * written waits for a knowledge change in progress instead of reading past
 * it. PGlite serves one connection, so none of this can be shown there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { pkbProducts } from "@/db/schema";
import { lockProductKnowledge } from "@/lib/pkb/common";
import { tryAcquireLocalAiSlot } from "@/lib/providers/local/slot";
import { undecidedKnowledge } from "@/lib/seo-pulse/service";
import { createRealTestDatabase, REAL_ADMIN_URL, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
const NAME = "local_ai_concurrency_test";
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase(NAME, 8);
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

/** A connection of its own, as another worker process would have. */
function otherProcess() {
  return postgres(REAL_ADMIN_URL.replace(/\/[^/]*$/, `/${NAME}`), { max: 1, onnotice: () => {} });
}

describe.skipIf(!available)("the local-AI slot across processes", () => {
  it("is refused while another process holds it, and free once that process lets go", async () => {
    const other = otherProcess();
    try {
      const [held] = await other`select pg_try_advisory_lock(hashtextextended(${"local-ai:slot:0"}, 0)) as ok`;
      expect(held.ok).toBe(true);
      expect(await tryAcquireLocalAiSlot(1)).toBeNull();

      await other`select pg_advisory_unlock(hashtextextended(${"local-ai:slot:0"}, 0))`;
      const slot = await tryAcquireLocalAiSlot(1);
      expect(slot).not.toBeNull();
      // Now the other process is the one refused.
      const [refused] = await other`select pg_try_advisory_lock(hashtextextended(${"local-ai:slot:0"}, 0)) as ok`;
      expect(refused.ok).toBe(false);
      await slot!.release();
      const [free] = await other`select pg_try_advisory_lock(hashtextextended(${"local-ai:slot:0"}, 0)) as ok`;
      expect(free.ok).toBe(true);
      await other`select pg_advisory_unlock(hashtextextended(${"local-ai:slot:0"}, 0))`;
    } finally {
      await other.end({ timeout: 1 });
    }
  });

  it("is freed by the database when the process holding it dies", async () => {
    const other = otherProcess();
    await other`select pg_advisory_lock(hashtextextended(${"local-ai:slot:0"}, 0))`;
    expect(await tryAcquireLocalAiSlot(1)).toBeNull();
    // The process dies without unlocking: its connection closes.
    await other.end({ timeout: 0 });
    let slot = null;
    for (let attempt = 0; attempt < 20 && !slot; attempt += 1) {
      slot = await tryAcquireLocalAiSlot(1);
      if (!slot) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(slot).not.toBeNull();
    await slot!.release();
  });

  it("allows as many holders as the configured concurrency, and no more", async () => {
    const first = await tryAcquireLocalAiSlot(2);
    const second = await tryAcquireLocalAiSlot(2);
    const third = await tryAcquireLocalAiSlot(2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    await first!.release();
    await second!.release();
  });
});

describe.skipIf(!available)("the final check before writing", () => {
  it("waits for a knowledge change in progress and then sees it", async () => {
    const [product] = await harness.db
      .insert(pkbProducts)
      .values({ name: "Concurrency Lamp", origin: "MANUAL_ADMIN", resolutionState: "HIGH_CONFIDENCE" })
      .returning({ id: pkbProducts.id });

    let changed!: () => void;
    const changing = new Promise<void>((resolve) => (changed = resolve));
    // A research run proposing a value, or a re-assessment: it takes the
    // knowledge lock, changes the product, and has not committed yet.
    const writer = harness.db.transaction(async (tx) => {
      await lockProductKnowledge(tx, product.id);
      await tx.update(pkbProducts).set({ resolutionState: "AMBIGUOUS" }).where(eq(pkbProducts.id, product.id));
      changed();
      await tx.execute(sql`select pg_sleep(0.4)`);
    });

    await changing;
    const started = Date.now();
    const seen = await harness.db.transaction(async (tx) => {
      await lockProductKnowledge(tx, product.id);
      return undecidedKnowledge(product.id, tx);
    });
    await writer;

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(seen).toContain("Which product this is has not been settled.");
  });
});
