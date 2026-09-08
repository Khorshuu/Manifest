/**
 * Applies the checked-in migration to an in-process Postgres (PGlite) and
 * asserts the invariants the schema is responsible for. This runs without any
 * external database, so the migration is verified on every test run rather
 * than only when someone happens to have Postgres installed.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

let fixtureCounter = 0;

/** Each call makes its own category and product, so slugs never collide. */
async function seedMinimalCatalog() {
  const n = ++fixtureCounter;
  const category = await db.query<{ id: string }>(
    `insert into categories (name, slug) values ($1, $2) returning id`,
    [`Category ${n}`, `category-${n}`],
  );
  const product = await db.query<{ id: string }>(
    `insert into products (category_id, title, slug, status)
     values ($1, $2, $3, 'preorder_open') returning id`,
    [category.rows[0].id, `Test product ${n}`, `test-product-${n}`],
  );
  return product.rows[0].id;
}

beforeAll(async () => {
  db = new PGlite();
  const sqlText = readFileSync(
    join(process.cwd(), "db/migrations/0000_initial_schema.sql"),
    "utf8",
  );
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await db.exec(trimmed);
  }
});

describe("migration", () => {
  it("creates every table the schema declares", async () => {
    const result = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(result.rows[0].count)).toBe(26);
  });
});

describe("capacity invariants", () => {
  it("rejects reserving more preorder slots than capacity", async () => {
    const productId = await seedMinimalCatalog();
    await expect(
      db.query(
        `insert into product_variants
           (product_id, sku, price_bdt, fulfillment_mode, preorder_capacity, preorder_reserved)
         values ($1, 'OVERSOLD-1', 100000, 'preorder', 5, 6)`,
        [productId],
      ),
    ).rejects.toThrow(/product_variants_reserved_within_capacity_check/);
  });

  it("rejects a negative reserved count", async () => {
    const productId = await seedMinimalCatalog();
    await expect(
      db.query(
        `insert into product_variants
           (product_id, sku, price_bdt, fulfillment_mode, preorder_capacity, preorder_reserved)
         values ($1, 'NEGATIVE-1', 100000, 'preorder', 5, -1)`,
        [productId],
      ),
    ).rejects.toThrow(/product_variants_reserved_non_negative_check/);
  });

  it("accepts reserving exactly up to capacity", async () => {
    const productId = await seedMinimalCatalog();
    await expect(
      db.query(
        `insert into product_variants
           (product_id, sku, price_bdt, fulfillment_mode, preorder_capacity, preorder_reserved)
         values ($1, 'EXACT-1', 100000, 'preorder', 5, 5)`,
        [productId],
      ),
    ).resolves.toBeDefined();
  });
});

describe("deposit invariants", () => {
  it("rejects a deposit variant with no deposit percent", async () => {
    const productId = await seedMinimalCatalog();
    await expect(
      db.query(
        `insert into product_variants
           (product_id, sku, price_bdt, fulfillment_mode, payment_mode)
         values ($1, 'DEPOSIT-1', 100000, 'preorder', 'deposit')`,
        [productId],
      ),
    ).rejects.toThrow(/deposit_requires_percent/);
  });
});

describe("role and status constraints", () => {
  it("rejects a role outside the three defined roles", async () => {
    await expect(
      db.query(
        `insert into users (email, password_hash, role)
         values ('nobody@example.com', 'x', 'root')`,
      ),
    ).rejects.toThrow(/users_role_check/);
  });

  it("rejects an order status outside the pipeline", async () => {
    await expect(
      db.query(
        `insert into orders
           (order_number, status, guest_email, shipping_address_id, subtotal_bdt,
            total_bdt, amount_due_now_bdt, idempotency_key)
         values ('ORD-1', 'teleported', 'guest@example.com', gen_random_uuid(), 1, 1, 1, 'key-1')`,
      ),
    ).rejects.toThrow(/orders_status_check/);
  });
});

describe("review integrity", () => {
  it("rejects a rating outside 1-5", async () => {
    await expect(
      db.query(
        `insert into reviews (product_id, user_id, order_item_id, rating)
         values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 6)`,
      ),
    ).rejects.toThrow(/reviews_rating_check/);
  });
});
