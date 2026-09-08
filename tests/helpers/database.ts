import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";

const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

/**
 * Spins up an in-process Postgres with the real migrations applied, and points
 * the application's database singleton at it, so `lib/` code under test runs
 * its actual queries rather than a stub.
 */
export async function createTestDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  setDatabaseForTesting(db as unknown as Database);

  return {
    client,
    db,
    /**
     * Empties every table in one statement. Deleting table by table is slow
     * enough in an in-process database to time out a test hook.
     */
    async reset() {
      await client.exec(`
        truncate table
          rate_limit_hits, notifications, audit_log, site_settings, reviews,
          payments, order_status_history, order_items, orders,
          wishlist_items, cart_items, carts,
          waitlist_entries, inventory_adjustments,
          variant_option_values, variant_images, product_variants,
          product_attributes, attribute_values, attributes,
          product_related, product_categories, product_images, products,
          categories, sessions, addresses, users
        restart identity cascade
      `);
    },
    async close() {
      setDatabaseForTesting(undefined);
      await client.close();
    },
  };
}
