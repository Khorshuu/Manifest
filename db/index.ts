import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

function createDatabase() {
  const env = getEnv();
  return drizzle(postgres(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX }), {
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
 * Proxy so callers import `db` directly while the connection is still created
 * lazily — importing this module must not open a connection or read the
 * environment at build time.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(getDb() as object, property, receiver);
  },
});

export { schema };
