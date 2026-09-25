/**
 * Runs a real PostgreSQL server for local development, using binaries shipped
 * by `embedded-postgres` — no system-wide Postgres installation and no admin
 * rights required. The application connects over postgres:// exactly as it
 * will in production, and multiple connections are supported, which the app
 * needs: Next serves pages and route handlers from separate processes.
 *
 * Run with: npm run db:server
 */
import "../lib/load-env";
import EmbeddedPostgres from "embedded-postgres";
import postgresClient from "postgres";
import { checkDatabaseEncoding } from "./encoding";

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DIR ?? "./.postgres-dev";

async function main() {
  const postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
    // A new cluster is UTF-8 whatever the machine's locale (D-119): Windows
    // would otherwise initialise it as WIN1252, which cannot store most of
    // what a manufacturer's page says. An existing cluster is left as it is.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  // initialise() is only valid on an empty directory; on a second run the
  // cluster already exists and we go straight to start().
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("preorder");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not empty|already exists/i.test(message)) throw error;
    await postgres.start().catch(() => undefined);
  }

  process.stdout.write(
    `Development PostgreSQL listening on 127.0.0.1:${PORT}, data in ${DATA_DIR}\n`,
  );
  await reportEncoding();

  const shutdown = async () => {
    await postgres.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Says so when the database the app will use is not UTF-8 — typically a
 * cluster created before the flag above existed. Never recreates anything.
 */
async function reportEncoding() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = postgresClient(url, { max: 1, onnotice: () => {} });
  try {
    const problem = await checkDatabaseEncoding((text) => client.unsafe(text));
    if (problem) process.stderr.write(`\nWARNING — ${problem}\n\n`);
  } catch {
    // The app's database may not exist yet; `db:setup` reports it then.
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
