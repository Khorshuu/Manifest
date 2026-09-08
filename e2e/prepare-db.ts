import "../lib/load-env";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import { seed } from "../db/seed";

/**
 * Gives the end-to-end suite its own database, created fresh for every run.
 *
 * Without this the tests write into the development database, so a developer's
 * catalog slowly fills with "Test Product" rows and the storefront becomes
 * impossible to look at. It also makes assertions about seeded data reliable,
 * since nothing else has touched the rows.
 */
async function prepareDatabase() {
  const adminUrl =
    process.env.E2E_ADMIN_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/postgres";
  const databaseName = process.env.E2E_DATABASE_NAME ?? "preorder_e2e";
  const testUrl = adminUrl.replace(/\/[^/]*$/, `/${databaseName}`);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  // Drop any connections left by an interrupted run, or the drop will block.
  await admin
    .unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = '${databaseName}' and pid <> pg_backend_pid()`,
    )
    .catch(() => undefined);
  await admin.unsafe(`drop database if exists ${databaseName}`);
  await admin.unsafe(`create database ${databaseName}`);
  await admin.end();

  const client = postgres(testUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const migrationsDir = join(process.cwd(), "db/migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.unsafe(trimmed);
    }
  }

  await seed(db);
  await client.end();

  process.stdout.write(`End-to-end database ready: ${databaseName}
`);
}

prepareDatabase().catch((error) => {
  console.error(error);
  process.exit(1);
});
