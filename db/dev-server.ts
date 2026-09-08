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

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DIR ?? "./.postgres-dev";

async function main() {
  const postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
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

  const shutdown = async () => {
    await postgres.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
