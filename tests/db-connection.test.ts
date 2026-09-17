/**
 * Database connection settings (db/connection.ts): a small pool on serverless
 * hosts, prepared statements off behind a transaction pooler, and a way to
 * override both. Plus the application's transaction work with prepared
 * statements off, against real PostgreSQL.
 */
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectionOptions, isPooledUrl } from "@/db/connection";
import { REAL_ADMIN_URL, realServerAvailable } from "./helpers/real-database";

const POOLED = "postgres://user:pass@ep-quiet-sea-123456-pooler.ap-southeast-1.aws.neon.tech/shop?sslmode=require";
const DIRECT = "postgres://user:pass@ep-quiet-sea-123456.ap-southeast-1.aws.neon.tech/shop?sslmode=require";

describe("connectionOptions", () => {
  it("recognises Neon's pooled address", () => {
    expect(isPooledUrl(POOLED)).toBe(true);
    expect(isPooledUrl(DIRECT)).toBe(false);
    expect(isPooledUrl("not a url")).toBe(false);
  });

  it("keeps the pool small and closes idle connections on Vercel", () => {
    expect(connectionOptions(POOLED, { VERCEL: "1" })).toMatchObject({ max: 3, idle_timeout: 20, prepare: false });
  });

  it("uses a larger pool and prepared statements for a long-running server on a direct address", () => {
    expect(connectionOptions(DIRECT, {})).toMatchObject({ max: 10, prepare: true, idle_timeout: undefined });
  });

  it("honours explicit settings", () => {
    expect(connectionOptions(POOLED, { DATABASE_POOL_MAX: 5, DATABASE_PREPARE: "on", VERCEL: "1" })).toMatchObject({
      max: 5,
      prepare: true,
    });
    expect(connectionOptions(DIRECT, { DATABASE_PREPARE: "off" }).prepare).toBe(false);
  });
});

const available = await realServerAvailable();

describe.skipIf(!available)("without prepared statements", () => {
  it("runs locked transactions and parameterised queries as usual", async () => {
    const sql = postgres(REAL_ADMIN_URL, { ...connectionOptions(POOLED, { VERCEL: "1" }), max: 4 });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtextextended(${"db-connection-test"}, 0))`;
            const [row] = await tx`select ${index}::int + 1 as value`;
            return row.value as number;
          }),
        ),
      );
      expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
