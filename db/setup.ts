/**
 * Local convenience: apply pending migrations, then seed.
 *
 * The seed truncates the tables it owns, so this is for a development
 * database only; a deployment runs `db/migrate.ts`.
 *
 * Run with: npm run db:setup
 */
import "../lib/load-env";
import postgres from "postgres";
import { getDb } from "./index";
import { migratePostgres } from "./migrator";
import { seed } from "./seed";

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await migratePostgres(client);
  } finally {
    await client.end({ timeout: 5 });
  }

  await seed(getDb());
  // The seeded listings enter the knowledge base as LEGACY values (D-069).
  const { backfillKnowledge } = await import("../lib/pkb/maintenance");
  const knowledge = await backfillKnowledge();
  process.stdout.write(`Knowledge base: ${knowledge.processed} listings imported.\n`);
  process.stdout.write("Database ready.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
