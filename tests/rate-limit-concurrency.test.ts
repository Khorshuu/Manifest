/**
 * The rate limit under real concurrency.
 *
 * `tests/rate-limit.test.ts` runs on PGlite, which serves one connection: it
 * can prove the counting is right, and cannot prove that two simultaneous
 * attempts at the last slot in a window do not both succeed. That is the whole
 * question a shared limiter exists to answer, so it is asked here against the
 * real PostgreSQL server started by `npm run db:server`, on its own database.
 *
 * If that server is not running the suite skips rather than passing quietly.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { rateLimitHits } from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";
import { consumeRateLimit } from "@/lib/rate-limit";

const ADMIN_URL =
  process.env.CONCURRENCY_TEST_ADMIN_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const TEST_DB = "rate_limit_concurrency_test";
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

const POOL_SIZE = 20;

let client: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle> | undefined;

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

/** Probed at collection time: skipIf is evaluated when the file is loaded. */
const available = await serverIsReachable();

beforeAll(async () => {
  if (!available) return;

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB}`).catch(() => undefined);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();

  client = postgres(TEST_URL, { max: POOL_SIZE, onnotice: () => {} });
  db = drizzle(client, { schema });

  const migrationsDir = join(process.cwd(), "db/migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.unsafe(trimmed);
    }
  }

  /**
   * Warm every connection before racing. Pools connect lazily, so without this
   * the first attempt commits while the others are still doing TCP setup and
   * the suite passes whether or not the counting is atomic — the lesson from
   * the preorder concurrency suite (docs/TESTING.md).
   */
  await Promise.all(
    Array.from({ length: POOL_SIZE }, () => client!`select pg_sleep(0.05)`),
  );

  setDatabaseForTesting(db as unknown as Database);
}, 120_000);

afterAll(async () => {
  if (!available) return;

  setDatabaseForTesting(undefined);
  await client?.end({ timeout: 5 }).catch(() => undefined);

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB}`).catch(() => undefined);
  await admin.end();
}, 60_000);

beforeEach(async () => {
  if (!available) return;
  await client!`truncate table rate_limit_hits`;
});

describe.skipIf(!available)("under real concurrency", () => {
  /**
   * The question a shared limiter exists to answer: with one attempt left, do
   * twenty simultaneous requests all get told yes?
   */
  it("lets exactly one of many simultaneous attempts take the last slot", async () => {
    const limit = 5;
    const key = `race-${Math.random().toString(36).slice(2, 10)}`;

    // Use up all but one.
    for (let i = 0; i < limit - 1; i++) {
      await consumeRateLimit(key, limit, 60_000);
    }

    const results = await Promise.all(
      Array.from({ length: POOL_SIZE }, () =>
        consumeRateLimit(key, limit, 60_000),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
  });

  /** Over many rounds, the number allowed never exceeds the limit. */
  it("never allows more than the limit however the attempts interleave", async () => {
    const limit = 3;

    for (let round = 0; round < 10; round++) {
      const key = `burst-${round}-${Math.random().toString(36).slice(2, 8)}`;

      const results = await Promise.all(
        Array.from({ length: POOL_SIZE }, () =>
          consumeRateLimit(key, limit, 60_000),
        ),
      );

      const allowed = results.filter((result) => result.allowed).length;
      expect(allowed, `round ${round}`).toBe(limit);
    }
  });

  it("records one row per key and window, whatever the contention", async () => {
    const key = `single-row-${Math.random().toString(36).slice(2, 8)}`;

    await Promise.all(
      Array.from({ length: POOL_SIZE }, () =>
        consumeRateLimit(key, 1000, 60_000),
      ),
    );

    const rows = await db!.select().from(rateLimitHits);

    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(POOL_SIZE);
  });
});

describe.skipIf(available)("without a server", () => {
  it("records that the concurrency suite did not run", () => {
    expect(available).toBe(false);
  });
});
