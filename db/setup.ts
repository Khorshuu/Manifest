/**
 * Creates the schema and loads seed data in one step, against whatever
 * DATABASE_URL points at — a real Postgres server, or the in-process PGlite
 * database used when no server is installed.
 *
 * Run with: npm run db:setup
 */
import "../lib/load-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./index";
import { seed } from "./seed";

const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

async function applyMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const db = getDb();

  for (const file of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`Applying ${file}...\n`);

    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      try {
        await db.execute(trimmed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Re-running setup on an existing database is expected and harmless.
        if (/already exists/i.test(message)) continue;
        throw error;
      }
    }
  }
}

async function main() {
  await applyMigrations();
  await seed(getDb());
  process.stdout.write("Database ready.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
