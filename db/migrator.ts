import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";

/**
 * The migration runner, with a ledger.
 *
 * Every migrating caller — the deploy script, local setup, the end-to-end and
 * test harnesses, the scale generator — goes through `migrate`, so they apply
 * migrations the same way.
 *
 * Rules:
 *
 * - `schema_migrations` records each file once, with a checksum of its
 *   contents, in the same transaction as the file's statements. A file either
 *   applied completely and is recorded, or rolled back and is not.
 * - A failure names the file and rolls it back; nothing is swallowed.
 * - A recorded file whose contents have since changed stops the run: an
 *   applied migration is history, and editing it would silently diverge
 *   databases.
 * - An advisory lock keeps two deploys from migrating at once.
 *
 * Databases created before the ledger existed were migrated by a runner that
 * replayed every file on every deploy and ignored "already exists". Such a
 * database has tables but no ledger. For those, and only those, the files up
 * to `LEGACY_THROUGH` are replayed one final time the old way — exactly what
 * the old runner would have done on this deploy — and recorded as
 * `baselined`. Every later file is applied strictly, once.
 */

export const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

/** The last migration shipped by the replaying runner. Never change this. */
export const LEGACY_THROUGH = "0022_measurements_and_order_variant_snapshot.sql";

const LOCK_KEY = 7_270_001;
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export type MigrationExecutor = {
  exec(statement: string): Promise<void>;
  query<T>(statement: string): Promise<T[]>;
};

export type MigrationReport = {
  baselined: string[];
  applied: string[];
  alreadyApplied: number;
};

export class MigrationError extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(
      `Migration ${file} failed and was rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "MigrationError";
  }
}

export class MigrationChecksumError extends Error {
  constructor(readonly file: string) {
    super(
      `Migration ${file} has changed since it was applied. Applied migrations are history: add a new migration instead of editing this one.`,
    );
    this.name = "MigrationChecksumError";
  }
}

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      if (!FILE_NAME.test(name)) {
        throw new Error(`Migration file name "${name}" must look like 0023_short_name.sql.`);
      }
      return name;
    });
}

function contents(file: string, dir: string): string {
  // Line endings normalised, so a checkout with CRLF has the same checksum.
  return readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
}

export function migrationChecksum(file: string, dir = MIGRATIONS_DIR): string {
  return createHash("sha256").update(contents(file, dir)).digest("hex");
}

export function migrationStatements(file: string, dir = MIGRATIONS_DIR): string[] {
  return contents(file, dir)
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function messageOf(error: unknown): string {
  return [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause ? String(error.cause) : "",
  ].join(" ");
}

export async function migrate(
  executor: MigrationExecutor,
  options: { dir?: string; log?: (line: string) => void; legacyThrough?: string } = {},
): Promise<MigrationReport> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const legacyThrough = options.legacyThrough ?? LEGACY_THROUGH;
  const report: MigrationReport = { baselined: [], applied: [], alreadyApplied: 0 };

  await executor.exec(`select pg_advisory_lock(${LOCK_KEY})`);
  try {
    const [state] = await executor.query<{ ledger: boolean; legacy: boolean }>(
      `select to_regclass('public.schema_migrations') is not null as ledger,
              to_regclass('public.users') is not null as legacy`,
    );

    await executor.exec(`create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      mode text not null check (mode in ('applied', 'baselined')),
      duration_ms integer not null,
      applied_at timestamptz not null default now()
    )`);

    const files = migrationFiles(dir);
    const recorded = new Map(
      (await executor.query<{ name: string; checksum: string }>(
        "select name, checksum from schema_migrations",
      )).map((row) => [row.name, row.checksum]),
    );

    if (!state.ledger && state.legacy && recorded.size === 0) {
      log("Existing database without a migration ledger: baselining earlier migrations.");
      for (const file of files.filter((name) => name <= legacyThrough)) {
        const started = Date.now();
        for (const statement of migrationStatements(file, dir)) {
          try {
            await executor.exec(statement);
          } catch (error) {
            if (/already exists/i.test(messageOf(error))) continue;
            throw new MigrationError(file, error);
          }
        }
        const checksum = migrationChecksum(file, dir);
        await executor.exec(
          `insert into schema_migrations (name, checksum, mode, duration_ms)
           values ('${file}', '${checksum}', 'baselined', ${Date.now() - started})`,
        );
        recorded.set(file, checksum);
        report.baselined.push(file);
      }
    }

    for (const [file, checksum] of recorded) {
      if (!files.includes(file)) {
        log(`Warning: ${file} is recorded as applied but no longer exists in ${dir}.`);
      } else if (migrationChecksum(file, dir) !== checksum) {
        throw new MigrationChecksumError(file);
      }
    }

    for (const file of files) {
      if (recorded.has(file)) {
        if (!report.baselined.includes(file)) report.alreadyApplied += 1;
        continue;
      }

      log(`Applying ${file}...`);
      const started = Date.now();
      await executor.exec("begin");
      try {
        for (const statement of migrationStatements(file, dir)) {
          await executor.exec(statement);
        }
        await executor.exec(
          `insert into schema_migrations (name, checksum, mode, duration_ms)
           values ('${file}', '${migrationChecksum(file, dir)}', 'applied', ${Date.now() - started})`,
        );
        await executor.exec("commit");
      } catch (error) {
        await executor.exec("rollback").catch(() => undefined);
        throw new MigrationError(file, error);
      }
      report.applied.push(file);
    }

    return report;
  } finally {
    await executor.exec(`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
  }
}

export type MigrationStatus = {
  /** Whether the database has a migration ledger at all. */
  ledger: boolean;
  applied: number;
  /** The newest file recorded as applied or baselined. */
  latest: string | null;
  /** Files in the repository the database has not had yet. */
  pending: string[];
  /** Recorded files whose contents have since changed: `migrate` would stop on these. */
  changed: string[];
  /** Recorded files that are no longer in the repository. */
  unknown: string[];
};

/**
 * Where a database stands against the repository's migrations, read only:
 * no lock, no ledger created, nothing applied. For checks run before a
 * deployment (scripts/staging/check.ts), where `migrate` would be a write.
 */
export async function migrationStatus(executor: Pick<MigrationExecutor, "query">, dir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = migrationFiles(dir);
  const [state] = await executor.query<{ ledger: boolean }>(
    "select to_regclass('public.schema_migrations') is not null as ledger",
  );
  if (!state?.ledger) return { ledger: false, applied: 0, latest: null, pending: files, changed: [], unknown: [] };
  const recorded = await executor.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations order by name");
  const names = new Set(recorded.map((row) => row.name));
  return {
    ledger: true,
    applied: recorded.length,
    latest: recorded.at(-1)?.name ?? null,
    pending: files.filter((file) => !names.has(file)),
    changed: recorded.filter((row) => files.includes(row.name) && migrationChecksum(row.name, dir) !== row.checksum).map((row) => row.name),
    unknown: recorded.filter((row) => !files.includes(row.name)).map((row) => row.name),
  };
}

/** A postgres-js connection. Pass a reserved one: the lock and BEGIN need one session. */
export function postgresExecutor(connection: postgres.Sql | postgres.ReservedSql): MigrationExecutor {
  return {
    async exec(statement) {
      await connection.unsafe(statement);
    },
    async query<T>(statement: string) {
      return (await connection.unsafe(statement)) as unknown as T[];
    },
  };
}

/** PGlite, structurally typed so production code does not depend on it. */
export function pgliteExecutor(client: {
  exec(statement: string): Promise<unknown>;
  query<T>(statement: string): Promise<{ rows: T[] }>;
}): MigrationExecutor {
  return {
    async exec(statement) {
      await client.exec(statement);
    },
    async query<T>(statement: string) {
      return (await client.query<T>(statement)).rows;
    },
  };
}

/** Migrates through a postgres-js pool, on one reserved connection. */
export async function migratePostgres(
  sql: postgres.Sql,
  options: Parameters<typeof migrate>[1] = {},
): Promise<MigrationReport> {
  const reserved = await sql.reserve();
  try {
    return await migrate(postgresExecutor(reserved), options);
  } finally {
    reserved.release();
  }
}
