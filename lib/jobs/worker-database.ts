import postgres from "postgres";
import { connectionMode, declaredConnectionMode, type ConnectionModeReading } from "@/db/connection";
import { databaseIdentityProblem } from "@/db/identity";
import { probeSessionLock, type SessionLockProbe } from "@/db/session-probe";

/**
 * What the worker checks about its database before it claims anything
 * (D-134), and again for `npm run worker -- --check`.
 *
 *  - **Which database.** With EXPECTED_DATABASE_NAME set, a worker pointed at
 *    another environment's database refuses to start instead of running
 *    that environment's jobs.
 *  - **Whether a session lock holds.** The local-AI slot is a session
 *    advisory lock. An address known to be a transaction pooler's is refused
 *    by name (Neon's "-pooler", or DATABASE_CONNECTION_MODE=transaction);
 *    every other one is tested with a real lock (db/session-probe.ts), which
 *    catches a transaction pooler that does not say what it is. A pass is
 *    evidence rather than proof, and is reported as such.
 *
 * Opens its own two connections and closes them, so it can run before the
 * application's pool exists. States and the database's name only.
 */

export type WorkerDatabaseCheck = {
  database: string;
  expected: string | null;
  identity: "ok" | "mismatch" | "not_pinned";
  mode: ConnectionModeReading;
  sessionLock: SessionLockProbe["verdict"] | "not_needed";
  /** Reasons the worker must not start. Empty when it may. */
  problems: string[];
  /** Worth knowing, not worth refusing over. */
  notes: string[];
};

export async function checkWorkerDatabase(
  url: string,
  options: { localAi: boolean; expected?: string; declared?: ReturnType<typeof declaredConnectionMode> },
): Promise<WorkerDatabaseCheck> {
  const mode = connectionMode(url, options.declared ?? declaredConnectionMode());
  const expected = options.expected?.trim() || null;
  const problems: string[] = [];
  const notes: string[] = [];

  // Unnamed statements: they work through any pooler, so an undeclared one
  // is found by the lock test rather than by a prepared-statement error.
  const client = postgres(url, { max: 2, connect_timeout: 10, prepare: false, onnotice: () => {} });
  try {
    const [row] = await client<{ name: string }[]>`select current_database() as name`;
    const database = row.name;
    const identityProblem = databaseIdentityProblem(database, expected ?? undefined);
    if (identityProblem) problems.push(identityProblem);

    let sessionLock: WorkerDatabaseCheck["sessionLock"] = "not_needed";
    if (options.localAi) {
      if (mode.mode === "transaction") {
        problems.push(
          "Local AI is configured and DATABASE_URL is a transaction pooler's address; the local-AI slot needs the database's direct (or session-mode) address.",
        );
      } else {
        const probe = await probeSessionLock(client);
        sessionLock = probe.verdict;
        if (probe.verdict === "not_session") problems.push(probe.detail);
        else if (mode.mode === "unknown") {
          notes.push(
            "Session locks held in a test, but this address's mode is not declared. Set DATABASE_CONNECTION_MODE=direct (or session) once the provider confirms it.",
          );
        }
      }
    }

    return {
      database,
      expected,
      identity: !expected ? "not_pinned" : identityProblem ? "mismatch" : "ok",
      mode,
      sessionLock,
      problems,
      notes,
    };
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}
