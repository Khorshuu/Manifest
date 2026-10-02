import type postgres from "postgres";

/**
 * How the application connects to PostgreSQL (PRODUCTION-READINESS 21.1).
 *
 * On Vercel every function instance holds its own pool, and a traffic spike
 * starts many instances: ten connections each, times a few dozen instances,
 * exhausts a hosted database. The protection is a transaction pooler in front
 * of it (Neon's "-pooler" endpoint) and a small pool per instance, not a
 * bigger database. Three things follow:
 *
 * - The pool is small on Vercel (3 unless DATABASE_POOL_MAX says otherwise)
 *   and 10 elsewhere, where one long-running process serves everything.
 * - Idle connections are closed after 20 seconds on Vercel, so a frozen or
 *   quiet instance does not sit on server connections.
 * - Behind a transaction pooler each statement may run on a different server
 *   connection, so named prepared statements are turned off. Transactions are
 *   still pinned to one connection, and the application's advisory locks are
 *   all transaction-scoped, so they are unaffected. The one session-scoped
 *   lock — migrations — runs over the unpooled address (db/migrate.ts).
 */

export type ConnectionEnvironment = {
  DATABASE_POOL_MAX?: number;
  DATABASE_PREPARE?: "auto" | "on" | "off";
  DATABASE_CONNECTION_MODE?: ConnectionMode;
  VERCEL?: string;
};

/** Neon marks its pooled endpoints with "-pooler" in the host name. */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return false;
  }
}

/**
 * How a connection string reaches the server (D-134):
 *
 *  - `direct` — straight to PostgreSQL;
 *  - `session` — through a pooler in session mode, which gives each client
 *    one server connection for as long as it is connected;
 *  - `transaction` — through a pooler in transaction mode, which may run each
 *    statement outside a transaction on a different server connection.
 *
 * Session advisory locks (the migration lock, the local-AI slot) are only
 * locks on the first two.
 */
export type ConnectionMode = "direct" | "session" | "transaction";

export type ConnectionModeReading = {
  mode: ConnectionMode | "unknown";
  /**
   * What the reading rests on: the address itself (Neon's "-pooler" host), the
   * operator's DATABASE_CONNECTION_MODE, a database on this machine, or
   * nothing at all.
   */
  source: "address" | "declared" | "loopback" | "none";
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * What can be known about a connection string's mode without connecting.
 *
 * Only Neon says so in its host name. Every other provider's pooler is
 * ordinary-looking, so an address without "-pooler" is not taken to be
 * direct: unless DATABASE_CONNECTION_MODE declares it, or it is on this
 * machine, it is `unknown`. A declaration never overrides an address that
 * says it is pooled.
 */
export function connectionMode(url: string, declared?: ConnectionMode): ConnectionModeReading {
  if (isPooledUrl(url)) return { mode: "transaction", source: "address" };
  if (declared) return { mode: declared, source: "declared" };
  try {
    if (LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())) return { mode: "direct", source: "loopback" };
  } catch {
    // An unparseable address is reported as unknown; connecting will say why.
  }
  return { mode: "unknown", source: "none" };
}

/** DATABASE_CONNECTION_MODE, when it holds one of the three modes. */
export function declaredConnectionMode(value: string | undefined = process.env.DATABASE_CONNECTION_MODE): ConnectionMode | undefined {
  const mode = value?.trim().toLowerCase();
  return mode === "direct" || mode === "session" || mode === "transaction" ? mode : undefined;
}

export function connectionOptions(url: string, env: ConnectionEnvironment): postgres.Options<Record<string, never>> {
  const serverless = Boolean(env.VERCEL);
  const prepare =
    env.DATABASE_PREPARE === "on"
      ? true
      : env.DATABASE_PREPARE === "off"
        ? false
        : connectionMode(url, env.DATABASE_CONNECTION_MODE).mode !== "transaction";

  return {
    max: env.DATABASE_POOL_MAX ?? (serverless ? 3 : 10),
    prepare,
    idle_timeout: serverless ? 20 : undefined,
    // Recycled now and then, so a connection does not outlive a pooler or
    // database restart by long.
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    onnotice: () => {},
  };
}
