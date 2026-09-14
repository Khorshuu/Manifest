/**
 * The migration ledger (db/migrator.ts).
 *
 * Two paths have to work: a brand-new database, and a database from the
 * previous release that was migrated by the old replaying runner and holds
 * real data. The second is the one a deployment actually takes.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_THROUGH,
  MIGRATIONS_DIR,
  MigrationChecksumError,
  MigrationError,
  migrate,
  migrationFiles,
  pgliteExecutor,
} from "@/db/migrator";

const opened: PGlite[] = [];
const temporary: string[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  opened.push(client);
  return client;
}

/** A copy of the real migrations that a test can add files to. */
function migrationsCopy() {
  const dir = mkdtempSync(join(tmpdir(), "manifest-migrations-"));
  temporary.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

/**
 * What the previous release's runner did: every file it shipped with, "already
 * exists" ignored, no ledger. It never saw anything after LEGACY_THROUGH.
 */
async function migrateTheOldWay(client: PGlite) {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name <= LEGACY_THROUGH)
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint")) {
      if (!statement.trim()) continue;
      try {
        await client.exec(statement);
      } catch (error) {
        if (!/already exists/i.test(String(error))) throw error;
      }
    }
  }
}

const quiet = { log: () => undefined };

describe("a fresh database", () => {
  it("applies every migration once and records each one", async () => {
    const client = database();
    const report = await migrate(pgliteExecutor(client), quiet);

    const files = migrationFiles();
    expect(report.applied).toEqual(files);
    expect(report.baselined).toEqual([]);

    const { rows } = await client.query<{ name: string; mode: string }>(
      "select name, mode from schema_migrations order by name",
    );
    expect(rows.map((row) => row.name)).toEqual(files);
    expect(new Set(rows.map((row) => row.mode))).toEqual(new Set(["applied"]));
  }, 120_000);

  it("does nothing on a second run", async () => {
    const client = database();
    await migrate(pgliteExecutor(client), quiet);
    const before = await client.query("select name, applied_at from schema_migrations order by name");

    const report = await migrate(pgliteExecutor(client), quiet);

    expect(report.applied).toEqual([]);
    expect(report.alreadyApplied).toBe(migrationFiles().length);
    const after = await client.query("select name, applied_at from schema_migrations order by name");
    expect(after.rows).toEqual(before.rows);
  }, 120_000);
});

describe("a database from the previous release", () => {
  it("baselines the old migrations, keeps the data, and applies only what is new", async () => {
    const client = database();
    await migrateTheOldWay(client);
    await client.exec(
      "insert into users (email, password_hash, role) values ('kept@example.com', 'x', 'customer')",
    );

    const dir = migrationsCopy();
    writeFileSync(
      join(dir, "9001_ledger_upgrade_probe.sql"),
      "alter table users add column ledger_probe text;\n--> statement-breakpoint\nupdate users set ledger_probe = 'seen';",
    );

    const report = await migrate(pgliteExecutor(client), { ...quiet, dir });

    expect(report.baselined).toEqual(migrationFiles().filter((file) => file <= LEGACY_THROUGH));
    // Everything the old runner never shipped is applied strictly, once.
    expect(report.applied).toEqual([
      ...migrationFiles().filter((file) => file > LEGACY_THROUGH),
      "9001_ledger_upgrade_probe.sql",
    ]);

    const { rows } = await client.query<{ email: string; ledger_probe: string }>(
      "select email, ledger_probe from users",
    );
    expect(rows).toEqual([{ email: "kept@example.com", ledger_probe: "seen" }]);

    // Deploying again replays nothing.
    const again = await migrate(pgliteExecutor(client), { ...quiet, dir });
    expect(again.applied).toEqual([]);
    expect(again.baselined).toEqual([]);
  }, 180_000);
});

describe("failures", () => {
  it("rolls back a failing migration, names it, and records nothing", async () => {
    const client = database();
    const dir = migrationsCopy();
    await migrate(pgliteExecutor(client), { ...quiet, dir });

    const broken = "9002_half_broken.sql";
    writeFileSync(
      join(dir, broken),
      "create table half_broken (id int);\n--> statement-breakpoint\nselect * from table_that_does_not_exist;",
    );

    await expect(migrate(pgliteExecutor(client), { ...quiet, dir })).rejects.toThrow(MigrationError);
    await expect(migrate(pgliteExecutor(client), { ...quiet, dir })).rejects.toThrow(/9002_half_broken\.sql/);

    const table = await client.query<{ exists: boolean }>(
      "select to_regclass('public.half_broken') is not null as exists",
    );
    expect(table.rows[0].exists).toBe(false);
    const ledger = await client.query(`select 1 from schema_migrations where name = '${broken}'`);
    expect(ledger.rows).toHaveLength(0);

    // Fixed, it applies on the next run.
    writeFileSync(join(dir, broken), "create table half_broken (id int);");
    const report = await migrate(pgliteExecutor(client), { ...quiet, dir });
    expect(report.applied).toEqual([broken]);
  }, 180_000);

  it("refuses to continue when an applied migration was edited", async () => {
    const client = database();
    const dir = migrationsCopy();
    await migrate(pgliteExecutor(client), { ...quiet, dir });

    const first = migrationFiles(dir)[0];
    writeFileSync(join(dir, first), `${readFileSync(join(dir, first), "utf8")}\n-- edited later`);

    await expect(migrate(pgliteExecutor(client), { ...quiet, dir })).rejects.toThrow(MigrationChecksumError);
  }, 120_000);
});
