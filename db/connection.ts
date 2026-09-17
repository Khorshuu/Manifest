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

export function connectionOptions(url: string, env: ConnectionEnvironment): postgres.Options<Record<string, never>> {
  const serverless = Boolean(env.VERCEL);
  const prepare =
    env.DATABASE_PREPARE === "on" ? true : env.DATABASE_PREPARE === "off" ? false : !isPooledUrl(url);

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
