/**
 * CLI entry point for the development seed: npm run db:seed
 *
 * The seed data itself lives in ./seed.ts so it can also be run against an
 * in-process database in tests.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { seed } from "./seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await seed(db);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
