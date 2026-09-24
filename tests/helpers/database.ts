import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import { setDatabaseForTesting, type Database } from "@/db";
import { migrate, pgliteExecutor } from "@/db/migrator";

/**
 * Spins up an in-process Postgres with the real migrations applied, and points
 * the application's database singleton at it, so `lib/` code under test runs
 * its actual queries rather than a stub.
 */
export async function createTestDatabase() {
  // pg_trgm backs the search vocabulary (migration 0014); PGlite ships it as
  // an extension that has to be loaded before the migration can create it.
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });

  // The same ledger-keeping runner a deployment uses (db/migrator.ts).
  await migrate(pgliteExecutor(client), { log: () => undefined });

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
          pkb_sync_queue, pkb_unmapped_values, pkb_legacy_attribute_map, pkb_aliases, pkb_relationships,
          pkb_identifiers, pkb_fact_history, pkb_facts, pkb_claims, pkb_evidence, pkb_sources,
          pkb_variants, pkb_products, pkb_family_attributes, pkb_family_versions, pkb_families,
          pkb_attribute_options, pkb_attribute_definitions, pkb_brands,
          search_queries, search_clicks, search_history, search_synonyms,
          product_search_words, product_search_queue, product_search,
          product_preparation_runs, seo_research_runs, sku_reservations, recovery_codes, rate_limit_hits, notifications, audit_log, site_settings, reviews,
          media_objects, jobs, scheduler_heartbeats, payment_events, payments, order_status_history, order_items, orders,
          wishlist_items, cart_items, carts,
          waitlist_entries, inventory_adjustments,
          variant_option_values, variant_images, product_variants,
          product_attributes, attribute_values, attributes,
          product_related, product_categories, product_images, products,
          categories, sessions, oauth_accounts, addresses, newsletter_subscribers, users
        restart identity cascade
      `);
    },
    async close() {
      setDatabaseForTesting(undefined);
      await client.close();
    },
  };
}
