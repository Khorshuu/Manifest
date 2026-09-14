/**
 * The check every destructive data tool runs before it touches a database.
 *
 * DATABASE_URL is never assumed to be safe. A tool that bulk-inserts or wipes
 * data refuses unless the target looks disposable by every test we can apply
 * without trusting the caller: its name says it is scratch, it is on this
 * machine (or remote use was asked for explicitly), and the process is not
 * running as production.
 */

const SCRATCH_NAME = /(^|_)(scratch|scale|bench|perf|load|loadtest)(_|$)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run against this database: ${reason}`);
    this.name = "UnsafeDatabaseError";
  }
}

export type ScratchTarget = { host: string; database: string };

export function assertScratchDatabase(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ScratchTarget {
  if (!url) throw new UnsafeDatabaseError("no connection string was given.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeDatabaseError("the connection string could not be parsed.");
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new UnsafeDatabaseError("it is not a postgres:// connection string.");
  }

  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    throw new UnsafeDatabaseError("the process is running as production.");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!SCRATCH_NAME.test(database)) {
    throw new UnsafeDatabaseError(
      `"${database}" is not named as scratch (use a name containing _scratch, _scale, _bench, _perf or _load).`,
    );
  }

  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host) && env.SCALE_SEED_ALLOW_REMOTE !== "1") {
    throw new UnsafeDatabaseError(
      `"${host}" is not this machine. Set SCALE_SEED_ALLOW_REMOTE=1 for a disposable remote branch.`,
    );
  }

  return { host, database };
}
