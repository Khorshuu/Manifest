import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import { connectionOptions } from "./connection";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

function createDatabase() {
  const env = getEnv();
  const options = connectionOptions(env.DATABASE_URL, { ...env, VERCEL: process.env.VERCEL });
  return drizzle(postgres(env.DATABASE_URL, options), {
    schema,
  });
}

let instance: Database | undefined;

export function getDb(): Database {
  instance ??= createDatabase();
  return instance;
}

/**
 * Replaces the database used by every caller. Only for tests, which run
 * against an in-process Postgres; nothing in the application calls this.
 */
export function setDatabaseForTesting(database: Database | undefined): void {
  instance = database;
}

/**
 * Work to do once the surrounding transaction has committed.
 *
 * Invalidating cached storefront data from inside a transaction is a race: a
 * request arriving before the commit reads the old rows and caches them again,
 * and they stay until the entry expires (found by the homepage campaign test).
 * `db.transaction` below runs its callback with a queue; anything registered
 * here runs after a successful commit, before the caller returns, and is
 * dropped if the transaction rolls back or is retried.
 */
const afterCommitQueue = new AsyncLocalStorage<Array<() => void>>();

/** Queues work for after the current transaction commits. False when there is none. */
export function runAfterCommit(work: () => void): boolean {
  const queue = afterCommitQueue.getStore();
  if (!queue) return false;
  queue.push(work);
  return true;
}

/**
 * Proxy so callers import `db` directly while the connection is still created
 * lazily — importing this module must not open a connection or read the
 * environment at build time.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    const database = getDb();
    if (property === "transaction") {
      return async (...args: Parameters<Database["transaction"]>) => {
        // A transaction opened inside another commits with the outer one.
        if (afterCommitQueue.getStore()) return database.transaction(...args);
        const queue: Array<() => void> = [];
        const result = await afterCommitQueue.run(queue, () => database.transaction(...args));
        for (const work of queue) {
          try {
            work();
          } catch {
            // After-commit work never fails the write that committed.
          }
        }
        return result;
      };
    }
    return Reflect.get(database as object, property, receiver);
  },
});

export { schema };
