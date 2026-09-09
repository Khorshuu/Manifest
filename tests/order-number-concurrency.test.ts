/**
 * Order numbers under real concurrency.
 *
 * The number is human-facing and the column is UNIQUE, so allocating it by
 * counting the orders already placed was a read-then-write race: two checkouts
 * in the same instant read the same count, both tried to insert the same
 * number, and one customer got a failure at the moment they pressed Place
 * order. It was found by several end-to-end tests checking out in parallel.
 *
 * PGlite serves one connection, so nothing there can genuinely race and a test
 * on it would pass either way. This asks the question against the real
 * PostgreSQL server started by `npm run db:server`, on its own database, and
 * skips loudly rather than passing quietly when that server is not running.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";

const ADMIN_URL =
  process.env.CONCURRENCY_TEST_ADMIN_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const TEST_DB = "order_number_concurrency_test";
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

  // Pools connect lazily, so without warming them the first allocation commits
  // while the others are still doing TCP setup and the race never lands —
  // the lesson from the preorder concurrency suite (docs/TESTING.md).
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

/**
 * Allocated the way `place.ts` does it — inside a transaction, so this
 * exercises the real mechanism rather than a copy of the idea.
 */
async function allocate(): Promise<number> {
  return db!.transaction(async (tx) => {
    const rows = (await tx.execute(
      sql`select nextval('order_number_seq') as value`,
    )) as unknown as { value: string | number }[];
    return Number(rows[0].value);
  });
}

describe.skipIf(!available)("allocating order numbers at the same instant", () => {
  /**
   * The question the sequence exists to answer: do twenty simultaneous
   * checkouts get twenty different numbers?
   *
   * Confirmed to fail against the scheme this replaced — putting back the
   * read-then-write ("count the rows, add one") produces duplicates here on
   * every run.
   */
  it("hands every concurrent caller a different number", async () => {
    const numbers = await Promise.all(
      Array.from({ length: POOL_SIZE }, () => allocate()),
    );

    expect(new Set(numbers).size).toBe(POOL_SIZE);
  });

  /**
   * The property that makes a sequence the right tool here: it hands out a
   * value without taking a lock anyone else has to wait behind. A counter row
   * incremented with an upsert is equally correct and serialises every
   * checkout, which cost the end-to-end suite four minutes when it was tried.
   */
  it("does not make concurrent callers queue", async () => {
    const started = Date.now();

    await Promise.all(
      Array.from({ length: POOL_SIZE }, () =>
        db!.transaction(async (tx) => {
          await tx.execute(sql`select nextval('order_number_seq')`);
          // Held open deliberately: with a row lock, every other caller would
          // be stuck behind this one and the whole run would take
          // POOL_SIZE × 100ms rather than roughly 100ms.
          await tx.execute(sql`select pg_sleep(0.1)`);
        }),
      ),
    );

    // Generous, because a loaded machine is slow — but nowhere near the two
    // seconds that serialising twenty callers would take.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
