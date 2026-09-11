/**
 * Runs the real development seed against an in-process Postgres, so the seed
 * is verified to actually apply rather than assumed to work. Also asserts the
 * shape of the data later phases will rely on (a 3-level category tree, an
 * at-capacity variant to exercise the waitlist path).
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seed } from "@/db/seed";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  // pg_trgm backs the search vocabulary (migration 0014).
  client = new PGlite({ extensions: { pg_trgm } });
  db = drizzle(client, { schema });

  /**
   * Every migration, in order — not just the first one. This applied only
   * `0000` for a long time, which meant the seed was being checked against a
   * schema the application had long since moved past; it went unnoticed until
   * a later migration touched a table the seed writes to.
   */
  const migrationsDir = join(process.cwd(), "db/migrations");

  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sqlText = readFileSync(join(migrationsDir, file), "utf8");

    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  await seed(db);
}, 60_000);

describe("seed", () => {
  it("creates one user per role", async () => {
    const result = await client.query<{ role: string; count: string }>(
      `select role, count(*)::text as count from users group by role order by role`,
    );
    expect(result.rows).toEqual([
      { role: "customer", count: "1" },
      { role: "staff_admin", count: "1" },
      { role: "super_admin", count: "1" },
    ]);
  });

  it("creates a category tree at least three levels deep", async () => {
    const result = await client.query<{ depth: string }>(`
      with recursive tree as (
        select id, 1 as depth from categories where parent_id is null
        union all
        select c.id, tree.depth + 1 from categories c join tree on c.parent_id = tree.id
      )
      select max(depth)::text as depth from tree
    `);
    expect(Number(result.rows[0].depth)).toBeGreaterThanOrEqual(3);
  });

  it("hashes seeded passwords rather than storing them in the clear", async () => {
    const result = await client.query<{ password_hash: string }>(
      `select password_hash from users limit 1`,
    );
    expect(result.rows[0].password_hash).not.toContain("password123");
    expect(result.rows[0].password_hash.startsWith("$argon2")).toBe(true);
  });

  it("includes a variant already at full preorder capacity", async () => {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from product_variants
       where preorder_capacity is not null and preorder_reserved = preorder_capacity`,
    );
    expect(Number(result.rows[0].count)).toBeGreaterThan(0);
  });

  it("prices every variant in whole paisa", async () => {
    const result = await client.query<{ price_bdt: number }>(
      `select price_bdt from product_variants`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Number.isInteger(row.price_bdt)).toBe(true);
    }
  });

  it("is re-runnable without duplicating data", async () => {
    const before = await client.query<{ count: string }>(
      `select count(*)::text as count from products`,
    );

    await seed(db);

    const after = await client.query<{ count: string }>(
      `select count(*)::text as count from products`,
    );

    // The count is read rather than hardcoded: the catalogue grows, and a test
    // that pins the number fails on every product added rather than on the
    // duplication it exists to catch.
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(Number(after.rows[0].count)).toBeGreaterThan(1);
  }, 60_000);
});
