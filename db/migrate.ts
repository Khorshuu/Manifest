/**
 * Applies the checked-in migrations, and nothing else.
 *
 * `db/setup.ts` is the local convenience: it migrates *and* seeds, and the
 * seed truncates the tables it owns, so it must never touch a real shop. This
 * script is the one a deployment runs. It is idempotent — a statement that
 * reports the object already exists is skipped — so it is safe on every build.
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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import { users } from "./schema";

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
        // Drizzle wraps driver errors, so the useful text is on the cause.
        const message = [
          error instanceof Error ? error.message : String(error),
          error instanceof Error && error.cause ? String(error.cause) : "",
        ].join(" ");

        // Re-running against an existing database is expected and harmless.
        if (/already exists/i.test(message)) continue;
        throw error;
      }
    }
  }
}

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
  if (!process.env.DATABASE_URL?.trim()) {
    process.stdout.write("No DATABASE_URL; skipping migrations.\n");
    process.exit(0);
  }

  await applyMigrations();
  await ensureFirstAdministrator();
  process.stdout.write("Database schema is up to date.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
