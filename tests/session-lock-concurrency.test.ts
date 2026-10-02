/**
 * D-134 on the real PostgreSQL server: the checks that decide whether a
 * hosted database may be used — which database a connection reached, whether
 * a session advisory lock holds over it, where its migrations stand — and
 * the deploy migration refusing a database it was not meant for.
 *
 * A transaction pooler is imitated by sending each statement to the next of
 * several server connections, which is what one does to a client that is not
 * inside a transaction. PGlite serves one connection, so none of this can be
 * shown there.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeSessionLock } from "@/db/session-probe";
import { checkWorkerDatabase } from "@/lib/jobs/worker-database";
import { checkDatabaseLive } from "@/lib/staging/live-check";
import { createRealTestDatabase, REAL_ADMIN_URL, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
const NAME = "session_lock_concurrency_test";
const EMPTY = "migrate_guard_test";
const urlOf = (name: string) => REAL_ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;

async function recreate(name: string) {
  const admin = postgres(REAL_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`);
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
}

async function drop(name: string) {
  const admin = postgres(REAL_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`);
    await admin.unsafe(`drop database if exists ${name}`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase(NAME, 4);
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
  await drop(EMPTY);
}, 60_000);

async function ledgerExists(name: string): Promise<boolean> {
  const client = postgres(urlOf(name), { max: 1, onnotice: () => {} });
  try {
    const [row] = await client`select to_regclass('public.schema_migrations') is not null as present`;
    return row.present as boolean;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/** Advisory locks anyone holds in the test database. */
async function advisoryLocksHeld(): Promise<number> {
  const [row] = await harness.client`
    select count(*)::int as held from pg_locks
    where locktype = 'advisory' and database = (select oid from pg_database where datname = ${NAME})`;
  return row.held;
}

/** A client that behaves like one behind a transaction pooler: each statement on the next server connection. */
function transactionPooler(connections: postgres.Sql[]) {
  let next = 0;
  const statement = (strings: TemplateStringsArray, ...values: unknown[]) =>
    (connections[next++ % connections.length] as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
  return Object.assign(statement, {
    reserve: async () => Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => statement(strings, ...values), { release() {} }),
  }) as unknown as postgres.Sql;
}

describe.skipIf(!available)("testing a session lock against the database", () => {
  it("passes over a direct connection, and leaves no lock behind", async () => {
    const client = postgres(urlOf(NAME), { max: 2, onnotice: () => {} });
    try {
      const probe = await probeSessionLock(client);
      expect(probe.verdict).toBe("session");
      expect(probe.checks).toEqual({ samePid: true, refusedElsewhere: true, releasedBySession: true, freeAfterRelease: true });
    } finally {
      await client.end({ timeout: 1 });
    }
    expect(await advisoryLocksHeld()).toBe(0);
  });

  it("catches a pooler that hands each statement to another connection, and still leaves no lock behind", async () => {
    const connections = [0, 1, 2].map(() => postgres(urlOf(NAME), { max: 1, onnotice: () => {} }));
    try {
      const probe = await probeSessionLock(transactionPooler(connections));
      expect(probe.verdict).toBe("not_session");
      expect(probe.detail).toMatch(/transaction pooler/);
    } finally {
      await Promise.all(connections.map((connection) => connection.end({ timeout: 1 })));
    }
    expect(await advisoryLocksHeld()).toBe(0);
  });
});

describe.skipIf(!available)("the worker's database check", () => {
  it("accepts the database it expects, over a connection where the slot's lock holds", async () => {
    const check = await checkWorkerDatabase(urlOf(NAME), { localAi: true, expected: NAME });
    expect(check).toMatchObject({ database: NAME, identity: "ok", sessionLock: "session", problems: [] });
    expect(check.mode).toEqual({ mode: "direct", source: "loopback" });
  });

  it("refuses another environment's database, naming both and nothing else", async () => {
    const check = await checkWorkerDatabase(urlOf(NAME), { localAi: false, expected: "manifest_staging" });
    expect(check.identity).toBe("mismatch");
    expect(check.problems.join(" ")).toMatch(new RegExp(`"${NAME}".*"manifest_staging"`));
    expect(JSON.stringify(check)).not.toMatch(/postgres:\/\/|127\.0\.0\.1|postgres:postgres/);
  });

  it("refuses local AI over an address declared as a transaction pooler's, without testing it", async () => {
    const check = await checkWorkerDatabase(urlOf(NAME), { localAi: true, declared: "transaction" });
    expect(check.sessionLock).toBe("not_needed");
    expect(check.problems.join(" ")).toMatch(/transaction pooler/);
  });

  it("does not test the lock when no local AI is configured, and does not need a name pinned", async () => {
    const check = await checkWorkerDatabase(urlOf(NAME), { localAi: false });
    expect(check).toMatchObject({ identity: "not_pinned", sessionLock: "not_needed", problems: [] });
  });
});

describe.skipIf(!available)("the staging check's database report", () => {
  it("reports a migrated database it expects as ready, without writing to it", async () => {
    const before = await harness.client`select count(*)::int as n from schema_migrations`;
    const { items, database } = await checkDatabaseLive("Direct address", urlOf(NAME), { expected: NAME, staging: false, sessionLocks: true });
    expect(database).toBe(NAME);
    const byArea = Object.fromEntries(items.map((item) => [item.area.replace("Direct address: ", ""), item]));
    expect(byArea.connection.state).toBe("READY");
    expect(byArea.identity.state).toBe("READY");
    expect(byArea.TLS.state).toBe("READY");
    expect(byArea.migrations).toMatchObject({ state: "READY", detail: expect.stringMatching(/Up to date: \d+ applied, latest 004\d_/) });
    expect(byArea["session lock"].state).toBe("READY");
    expect(await harness.client`select count(*)::int as n from schema_migrations`).toEqual(before);
    expect(JSON.stringify(items)).not.toMatch(/postgres:\/\/|127\.0\.0\.1|postgres:postgres/);
  });

  it("refuses a test database as staging, and reports an unmigrated one as missing its ledger", async () => {
    await recreate(EMPTY);
    const { items } = await checkDatabaseLive("Direct address", urlOf(EMPTY), { staging: true, sessionLocks: false });
    expect(items.find((item) => item.area.endsWith("identity"))).toMatchObject({ state: "MISSING", detail: expect.stringMatching(/test or scratch/) });
    expect(items.find((item) => item.area.endsWith("migrations"))).toMatchObject({ state: "MISSING", detail: expect.stringMatching(/No migration ledger/) });
    expect(await ledgerExists(EMPTY)).toBe(false);
  });

  it("says why it could not connect, without quoting the server", async () => {
    const { items } = await checkDatabaseLive("Direct address", urlOf("no_such_database_test"), { staging: false, sessionLocks: false });
    expect(items).toEqual([{ area: "Direct address: connection", state: "MISSING", detail: "Could not connect: the database does not exist." }]);
  });
});

describe.skipIf(!available)("the deploy migration and EXPECTED_DATABASE_NAME", () => {
  const migrate = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "db/migrate.ts"], {
      env: { ...process.env, DATABASE_URL_UNPOOLED: "", ADMIN_EMAIL: "", ADMIN_PASSWORD: "", ...env },
      encoding: "utf8",
      timeout: 120_000,
    });

  it("stops before writing anything when the address reaches another database", async () => {
    await recreate(EMPTY);
    const result = migrate({ DATABASE_URL: urlOf(EMPTY), EXPECTED_DATABASE_NAME: "manifest_staging" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`Connected to database "${EMPTY}", but EXPECTED_DATABASE_NAME is "manifest_staging"`));
    expect(result.stderr + result.stdout).not.toMatch(/postgres:postgres/);
    expect(await ledgerExists(EMPTY)).toBe(false);
  }, 150_000);

  it("migrates the database it expects, through the real migration runner", async () => {
    await recreate(EMPTY);
    const result = migrate({ DATABASE_URL: urlOf(EMPTY), EXPECTED_DATABASE_NAME: EMPTY });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Migrations: \d+ applied, 0 baselined, 0 already applied/);
    expect(await ledgerExists(EMPTY)).toBe(true);
  }, 150_000);
});
