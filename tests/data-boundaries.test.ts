/**
 * Stage 7: what the Product Knowledge Base is allowed to hold, and what the
 * optional providers are allowed to say.
 *
 * The knowledge base is meant to outlive this shop — it is a description of
 * products, reusable and shareable (D-068). That only stays true if two things
 * are kept out of it: anything about a customer, and anything nobody measured.
 * Both are easy to add by accident and hard to remove afterwards, so they are
 * asserted here rather than left to review.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows } from "@/lib/pkb/common";
import { getProductResearchProvider } from "@/lib/providers/research";
import { getSearchConsoleProvider } from "@/lib/providers/search-console";
import { createTestDatabase } from "./helpers/database";

/*
 * Every assertion here is about the shape of the schema and the source, not
 * about any row, so the database only has to exist.
 */
let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe("the knowledge base holds no customer", () => {
  it("has no column that could carry a customer's name, address, email or order", async () => {
    const rows = await queryRows<{ table_name: string; column_name: string }>(
      harness.db,
      sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public' and table_name like 'pkb\\_%'
        order by table_name, column_name
      `,
    );

    // Names that would mean a person, an address, or something they bought.
    // `created_by` and `decided_by` are deliberately fine: they reference
    // `users`, which is staff attribution, and a decision has to be
    // attributable to be auditable at all (I-6).
    // Matched on whole name segments, so `sort_order` — a display position —
    // is not mistaken for something somebody bought.
    const forbidden =
      /(^|_)(customer|shopper|buyer|recipient|cart|payment|phone|postcode|postal|street|billing)(_|$)/;
    const purchase = /(^|_)order(_id|_number|s)?(_|$)/;
    const attribution = /^(created_by|decided_by|actor_user_id|locked_by|claimed_by)$/;
    const ordering = /^(sort_order|display_order)$/;

    const offenders = rows.filter((row) => {
      if (attribution.test(row.column_name) || ordering.test(row.column_name)) return false;
      return forbidden.test(row.column_name) || purchase.test(row.column_name);
    });
    expect(offenders).toEqual([]);
  });

  it("references no table that belongs to a customer", async () => {
    const references = await queryRows<{ from_table: string; to_table: string }>(
      harness.db,
      sql`
        select tc.table_name as from_table, ccu.table_name as to_table
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_schema = 'public'
          and tc.table_name like 'pkb\\_%'
      `,
    );

    // `users` is the one exception, and only for attribution: who suggested a
    // value and who decided on it.
    const customerTables = new Set([
      "orders",
      "order_items",
      "carts",
      "cart_items",
      "addresses",
      "payments",
      "reviews",
      "notifications",
      "sessions",
    ]);
    expect(references.filter((row) => customerTables.has(row.to_table))).toEqual([]);
  });

  it("keeps no record of what a shopper searched for once it has been counted", async () => {
    // The search phrase travels from the result a shopper clicked to their
    // order and is erased when the payment is confirmed (D-093). Nothing in
    // the knowledge base is a second copy of it.
    const columns = await queryRows<{ table_name: string; column_name: string }>(
      harness.db,
      sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name like 'pkb\\_%'
          and (column_name like '%query%' or column_name like '%visitor%')
      `,
    );
    expect(columns).toEqual([]);
  });
});

describe("Search Console stays internal analytics", () => {
  it("stores nothing about a customer", async () => {
    const columns = await queryRows<{ column_name: string }>(
      harness.db,
      sql`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'search_console_metrics'
      `,
    );

    const names = columns.map((row) => row.column_name).sort();
    // Google reports pages, searches and counts. A column that could hold a
    // person would mean this shop had started storing something Google does
    // not give it.
    expect(names.some((name) => /user|customer|visitor|session|ip|email/.test(name))).toBe(false);
  });

  it("is not exported by any of the shop's exports", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });

    const exportSources = walk(join(process.cwd(), "lib", "admin")).filter((path) => path.includes("export"));
    for (const path of exportSources) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/search_console|searchConsoleMetrics/);
    }
  });
});

describe("an unconfigured provider says so", () => {
  it("reports NOT_CONFIGURED rather than inventing an answer", async () => {
    // The provider getters read the validated environment, which nothing else
    // in this file needs. Only the two fields without a default.
    process.env.SESSION_SECRET ??= "s".repeat(32);
    process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/unused";

    const research = getProductResearchProvider();
    const discovery = await research.findSources({
      name: "Wireless headphones",
      brand: null,
      modelNumbers: [],
      gtins: [],
      preferredDomains: [],
      limit: 3,
    });
    expect(discovery.status).toBe("NOT_CONFIGURED");
    expect(discovery.status === "NOT_CONFIGURED" && discovery.message.length).toBeGreaterThan(0);

    const searchConsole = getSearchConsoleProvider();
    expect(searchConsole.connection().status).toBe("NOT_CONFIGURED");
  });

  it("invents no commercial SEO metric anywhere in the codebase", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });

    // Figures this shop cannot measure. They are absent rather than
    // estimated — a plausible number on a screen gets acted on (D-099).
    const invented = /\b(searchVolume|keywordDifficulty|costPerClick|cpc|backlinks|domainAuthority|competitorTraffic)\b/;
    const offenders: string[] = [];
    for (const path of [...walk(join(process.cwd(), "lib", "seo")), ...walk(join(process.cwd(), "lib", "search-console"))]) {
      const source = readFileSync(path, "utf8");
      // Only a declaration or an assignment counts; the words appear in prose
      // explaining why they are absent.
      for (const line of source.split("\n")) {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
        if (invented.test(line)) offenders.push(`${path}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
