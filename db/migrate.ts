/**
 * Applies pending migrations, and nothing else.
 *
 * `db/setup.ts` is the local convenience: it migrates *and* seeds, and the
 * seed truncates the tables it owns, so it must never touch a real shop. This
 * script is the one a deployment runs. Each migration is applied once and
 * recorded in `schema_migrations` (db/migrator.ts); running it again with
 * nothing pending does nothing.
 *
 * With no DATABASE_URL it does nothing and succeeds, because a build with no
 * database configured is still a valid build.
 *
 * It can also create the first administrator, which a fresh database has no
 * other way to obtain: set ADMIN_EMAIL and ADMIN_PASSWORD and the account is
 * created once, then left alone on later runs.
 *
 * Run with: npm run db:migrate:deploy
 */
import "../lib/load-env";
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "./index";
import { migratePostgres } from "./migrator";
import { users } from "./schema";

/**
 * Creates the owner's account if the shop has no staff yet. An existing
 * account is never modified, so leaving the variables in place cannot reset a
 * password that was changed later.
 */
async function ensureFirstAdministrator() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) return;

  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }

  const db = getDb();
  const existing = await db.execute(
    sql`select 1 from users where role <> 'customer' limit 1`,
  );
  if (existing.length > 0) {
    process.stdout.write("An administrator already exists; leaving it alone.\n");
    return;
  }

  await db.insert(users).values({
    email,
    firstName: "Owner",
    passwordHash: await hash(password),
    role: "super_admin",
    emailVerifiedAt: new Date(),
  });
  process.stdout.write(`Created the first administrator: ${email}\n`);
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    process.stdout.write("No DATABASE_URL; skipping migrations.\n");
    process.exit(0);
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const report = await migratePostgres(client);
    process.stdout.write(
      `Migrations: ${report.applied.length} applied, ${report.baselined.length} baselined, ${report.alreadyApplied} already applied.\n`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }

  await ensureFirstAdministrator();
  process.stdout.write("Database schema is up to date.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
