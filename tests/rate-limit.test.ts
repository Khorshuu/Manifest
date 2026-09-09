/**
 * Rate limiting, counted in the database.
 *
 * The rule these protect: a limit that resets when a process restarts, or that
 * counts separately on each instance, is not a limit on the deployment target
 * (docs/SECURITY.md). So these go through the real table rather than a stub.
 *
 * Genuine concurrency is proved separately in
 * `tests/rate-limit-concurrency.test.ts`, which needs a real server: PGlite
 * serves one connection, so nothing here can actually race.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimitHits } from "@/db/schema";
import {
  consumeRateLimit,
  pruneRateLimits,
  windowStartFor,
} from "@/lib/rate-limit";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe("counting attempts", () => {
  /*
   * These pass an explicit instant rather than letting the calls read the
   * clock. Windows are aligned to absolute time so separate processes agree
   * without coordinating — which means four calls that straddle a second
   * boundary land in two different windows and the count restarts. That made
   * the first test fail roughly whenever the run happened to cross one.
   */
  const at = 1_700_000_000_000;

  it("allows up to the limit, then blocks", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit("key", 3, 1000, at)).allowed).toBe(true);
    }
    expect((await consumeRateLimit("key", 3, 1000, at)).allowed).toBe(false);
  });

  it("counts each key separately, so one account cannot exhaust another", async () => {
    await consumeRateLimit("a", 1, 1000, at);
    expect((await consumeRateLimit("a", 1, 1000, at)).allowed).toBe(false);
    expect((await consumeRateLimit("b", 1, 1000, at)).allowed).toBe(true);
  });

  it("resets in the next window", async () => {
    const start = 1_000_000_000;
    await consumeRateLimit("key", 1, 1000, start);
    expect((await consumeRateLimit("key", 1, 1000, start + 500)).allowed).toBe(
      false,
    );
    expect((await consumeRateLimit("key", 1, 1000, start + 1500)).allowed).toBe(
      true,
    );
  });

  it("reports how long to wait when blocked", async () => {
    // Windows are aligned to absolute time, so this starts one exactly.
    const start = 1_000_000_000;
    await consumeRateLimit("key", 1, 10_000, start);
    const blocked = await consumeRateLimit("key", 1, 10_000, start + 2000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(8);
  });

  it("counts down what is left", async () => {
    expect((await consumeRateLimit("key", 3, 1000, at)).remaining).toBe(2);
    expect((await consumeRateLimit("key", 3, 1000, at)).remaining).toBe(1);
    expect((await consumeRateLimit("key", 3, 1000, at)).remaining).toBe(0);
  });
});

describe("sharing the count", () => {
  /**
   * The reason this moved out of memory. Two callers are two processes as far
   * as the table is concerned, and the third attempt has to be refused whoever
   * makes it.
   */
  it("counts attempts from different callers against one limit", async () => {
    const at = 1_700_000_000_000;
    expect((await consumeRateLimit("shared", 2, 60_000, at)).allowed).toBe(true);
    expect((await consumeRateLimit("shared", 2, 60_000, at)).allowed).toBe(true);
    expect((await consumeRateLimit("shared", 2, 60_000, at)).allowed).toBe(false);
  });

  // Whether two genuinely concurrent attempts can both take the last slot is
  // not answerable here: PGlite serves one connection, so anything "racing"
  // is serialised and the test would pass either way. That claim is proved
  // against a real server in tests/rate-limit-concurrency.test.ts.

  it("aligns windows to absolute time so processes agree without talking", () => {
    const windowMs = 60_000;
    const a = windowStartFor(1_700_000_123_456, windowMs);
    const b = windowStartFor(1_700_000_159_999, windowMs);

    expect(a.getTime()).toBe(b.getTime());
    expect(a.getTime() % windowMs).toBe(0);
  });
});

describe("what is stored", () => {
  /** A table of who tried to sign in and when should not name anyone. */
  it("never stores the email or address itself", async () => {
    await consumeRateLimit("login:email:shopper@example.com", 5, 60_000);

    const rows = await harness.db.select().from(rateLimitHits);

    expect(rows).toHaveLength(1);
    expect(rows[0].key).not.toContain("shopper@example.com");
    expect(rows[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps one row per key and window rather than one per attempt", async () => {
    for (let i = 0; i < 5; i++) {
      await consumeRateLimit("busy", 100, 60_000, 1_700_000_000_000);
    }

    const rows = await harness.db.select().from(rateLimitHits);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
  });
});

describe("pruning", () => {
  it("deletes closed windows and leaves the current one", async () => {
    const old = Date.now() - 48 * 60 * 60 * 1000;
    await consumeRateLimit("stale", 5, 60_000, old);
    await consumeRateLimit("fresh", 5, 60_000);

    const deleted = await pruneRateLimits();
    expect(deleted).toBe(1);

    const rows = await harness.db.select().from(rateLimitHits);
    expect(rows).toHaveLength(1);
  });

  it("is safe to run when there is nothing to delete", async () => {
    expect(await pruneRateLimits()).toBe(0);
  });
});

describe("when the database will not answer", () => {
  /**
   * Deliberately fails open. Signing in needs the database anyway, so a
   * database that cannot count attempts cannot check a password either —
   * refusing here would turn an outage into a lockout while protecting
   * nothing.
   */
  it("allows the attempt rather than locking everyone out", async () => {
    await harness.client.exec("drop table rate_limit_hits");

    const result = await consumeRateLimit("anything", 1, 1000);
    expect(result.allowed).toBe(true);

    // Restored for the next test, since the harness truncates rather than
    // rebuilds between tests.
    await harness.client.exec(`
      create table rate_limit_hits (
        key text not null,
        window_start timestamptz not null,
        count integer not null default 0,
        updated_at timestamptz not null default now(),
        primary key (key, window_start)
      )
    `);

    const rows = await harness.db.select().from(rateLimitHits);
    expect(rows).toHaveLength(0);
  });
});

describe("the login keys", () => {
  it("separates the per-account limit from the per-address one", async () => {
    // An office behind one address must not lock out because one colleague
    // mistyped their password.
    await consumeRateLimit("login:email:one@example.com", 1, 60_000);
    expect(
      (await consumeRateLimit("login:email:one@example.com", 1, 60_000)).allowed,
    ).toBe(false);
    expect(
      (await consumeRateLimit("login:email:two@example.com", 1, 60_000)).allowed,
    ).toBe(true);

    const rows = await harness.db
      .select()
      .from(rateLimitHits)
      .where(eq(rateLimitHits.count, 1));

    expect(rows.length).toBeGreaterThan(0);
  });
});
