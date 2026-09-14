import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";

/**
 * A disposable database on the real PostgreSQL server (`npm run db:server`).
 *
 * PGlite serves one connection, so it cannot produce a race. Suites that prove
 * a rule under concurrency use this instead, and skip — loudly, with a test
 * that says so — when no server is running.
 */

export const REAL_ADMIN_URL =
  process.env.CONCURRENCY_TEST_ADMIN_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

export async function realServerAvailable(): Promise<boolean> {
  const probe = postgres(REAL_ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
}

export async function createRealTestDatabase(name: string, poolSize = 24) {
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to recreate "${name}": test databases must end in _test.`);
  }

  const url = REAL_ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const admin = postgres(REAL_ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin
    .unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
    )
    .catch(() => undefined);
  await admin.unsafe(`drop database if exists ${name}`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();

  const client = postgres(url, { max: poolSize, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const dir = join(process.cwd(), "db/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.unsafe(trimmed);
    }
  }

  // Open every pooled connection before racing. A lazy pool lets the first
  // transaction finish while the rest are still connecting, and the suite then
  // passes whether or not the code is correct.
  await Promise.all(Array.from({ length: poolSize }, () => client`select pg_sleep(0.05)`));

  setDatabaseForTesting(db as unknown as Database);

  return {
    db,
    client,
    async close() {
      setDatabaseForTesting(undefined);
      await client.end({ timeout: 5 }).catch(() => undefined);
      const cleanup = postgres(REAL_ADMIN_URL, { max: 1, onnotice: () => {} });
      await cleanup
        .unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
        )
        .catch(() => undefined);
      await cleanup.unsafe(`drop database if exists ${name}`).catch(() => undefined);
      await cleanup.end();
    },
  };
}
