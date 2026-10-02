import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/**
 * Whether a session advisory lock actually behaves like one over a
 * connection string (D-134).
 *
 * The local-AI slot and the migration lock are session locks: one connection
 * takes the lock, keeps it while it works, and releases it. Through a
 * transaction pooler a client "connection" is not one server connection, so
 * the lock can be taken on one server connection, tested from another that
 * happens to be the same, and released on a third. Only Neon's addresses say
 * which kind they are; this asks the database instead.
 *
 * It holds one connection (`reserve`) the way the slot does, takes a lock
 * whose key nobody else uses, and checks, from that connection and from a
 * second one:
 *
 *  - the reserved connection kept the same server process throughout;
 *  - the second connection is refused the lock while it is held;
 *  - the release reports that this session held it;
 *  - the second connection can take it once it is released.
 *
 * A failure is proof that session locks are not reliable here. A pass is
 * evidence, not proof: a transaction pooler under no load can hand back the
 * same server connection every time. The lock is always released, on both
 * connections, whatever happened.
 */

export type SessionLockProbe = {
  verdict: "session" | "not_session" | "unsupported";
  /** One sentence an operator can act on. Never an address or a credential. */
  detail: string;
  checks: {
    samePid: boolean | null;
    refusedElsewhere: boolean | null;
    releasedBySession: boolean | null;
    freeAfterRelease: boolean | null;
  };
};

type Row = Record<string, unknown>;

export async function probeSessionLock(sql: postgres.Sql): Promise<SessionLockProbe> {
  const checks: SessionLockProbe["checks"] = { samePid: null, refusedElsewhere: null, releasedBySession: null, freeAfterRelease: null };
  if (typeof (sql as { reserve?: unknown }).reserve !== "function") {
    return { verdict: "unsupported", detail: "This client cannot hold one connection, so session locks cannot be tested.", checks };
  }

  const key = `manifest:session-probe:${randomUUID()}`;
  const reserved = await sql.reserve();
  let heldHere = false;
  let heldElsewhere = false;
  try {
    const pid = async (): Promise<number> => Number(((await reserved`select pg_backend_pid() as pid`) as Row[])[0]?.pid);
    const before = await pid();
    const [taken] = (await reserved`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`) as Row[];
    heldHere = taken?.ok === true;
    const during = await pid();

    const [elsewhere] = (await sql`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`) as Row[];
    heldElsewhere = elsewhere?.ok === true;
    checks.refusedElsewhere = heldHere && !heldElsewhere;
    if (heldElsewhere) {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      heldElsewhere = false;
    }

    const after = await pid();
    checks.samePid = before === during && during === after;

    const [released] = (await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0)) as ok`) as Row[];
    checks.releasedBySession = released?.ok === true;
    if (checks.releasedBySession) heldHere = false;

    const [free] = (await sql`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`) as Row[];
    checks.freeAfterRelease = free?.ok === true;
    if (checks.freeAfterRelease) await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
  } finally {
    if (heldHere) await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => undefined);
    if (heldElsewhere) await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => undefined);
    reserved.release();
  }

  const passed = Object.values(checks).every((value) => value === true);
  return passed
    ? {
        verdict: "session",
        detail: "A session advisory lock was held, excluded a second connection and was released by its own session.",
        checks,
      }
    : {
        verdict: "not_session",
        detail:
          "A session advisory lock did not behave as one: this address goes through a transaction pooler. Use the database's direct (or session-mode) address.",
        checks,
      };
}
