/**
 * Times the application's own data functions against a scale database.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/manifest_scale \
 *     npm run perf:bench -- --runs 7 [--json]
 *
 * Each path is warmed once, then run `--runs` times; p50/p95/p99 and the
 * number of SQL statements the path issued are reported. Read-only, but it
 * refuses a non-scratch database anyway so numbers are never mistaken for a
 * real shop's.
 */
import "../../lib/load-env";
import { sql } from "drizzle-orm";
import { assertScratchDatabase } from "../../db/scratch-guard";

assertScratchDatabase(process.env.DATABASE_URL);

const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag === -1 ? 7 : Math.max(1, Number(process.argv[runsFlag + 1]) || 7);
const JSON_OUTPUT = process.argv.includes("--json");

type Row = { label: string; p50: number; p95: number; p99: number; queries: number; rows: number | null };

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const { db, getDb } = await import("../../db");
  const catalog = await import("../../lib/catalog");
  const { discover } = await import("../../lib/catalog/discovery");
  const { suggestSearch } = await import("../../lib/search/suggest");
  const { searchProductsForAdmin } = await import("../../lib/catalog/products");
  const { searchOrdersForStaff } = await import("../../lib/orders/transitions");
  const { listCustomersWithOrders } = await import("../../lib/admin/customers");
  const admin = await import("../../lib/admin");
  const { exportOrdersCsv } = await import("../../lib/admin/export");

  let queries = 0;
  const client = (getDb() as unknown as { $client: { unsafe: (...args: unknown[]) => unknown } }).$client;
  const unsafe = client.unsafe.bind(client);
  client.unsafe = (...args: unknown[]) => {
    queries += 1;
    return unsafe(...args);
  };

  const results: Row[] = [];
  async function measure(label: string, work: () => Promise<unknown>) {
    await work();
    const samples: number[] = [];
    let issued = 0;
    let rows: number | null = null;
    for (let run = 0; run < RUNS; run += 1) {
      const before = queries;
      const started = performance.now();
      const output = await work();
      samples.push(performance.now() - started);
      issued = queries - before;
      if (Array.isArray(output)) rows = output.length;
    }
    samples.sort((a, b) => a - b);
    const row = {
      label,
      p50: Math.round(percentile(samples, 50)),
      p95: Math.round(percentile(samples, 95)),
      p99: Math.round(percentile(samples, 99)),
      queries: issued,
      rows,
    };
    results.push(row);
    if (!JSON_OUTPUT) {
      console.log(
        `${label.padEnd(52)} p50 ${String(row.p50).padStart(5)}ms  p95 ${String(row.p95).padStart(5)}ms  p99 ${String(row.p99).padStart(5)}ms  queries ${String(row.queries).padStart(3)}${rows === null ? "" : `  rows ${rows}`}`,
      );
    }
  }

  const [owner] = (await db.execute(
    sql`select id, email from users where role = 'super_admin' limit 1`,
  )) as unknown as { id: string; email: string }[];
  if (!owner) throw new Error("No super_admin in this database; run npm run db:seed:scale first.");
  const actor = { id: owner.id, email: owner.email, role: "super_admin" as const };

  const tree = await catalog.getCategoryTree();
  const rootIds = catalog.collectSubtreeIds(tree[0]);
  const [liveProduct] = (await db.execute(
    sql`select slug from products where status = 'preorder_open' order by slug limit 1`,
  )) as unknown as { slug: string }[];

  await measure("header: category tree + counts", () =>
    Promise.all([catalog.getCategoryTree(), catalog.countPublicProductsByCategory()]),
  );
  await measure("home: data", () =>
    Promise.all([
      catalog.listClosingSoon(8),
      catalog.listProductCards({ sort: "newest", limit: 20 }),
      catalog.pickCategoryImages(),
    ]),
  );
  for (const sort of ["featured", "price_asc", "best_selling"]) {
    await measure(`category: root shelf sort=${sort}`, () => discover({ params: { sort }, categoryIds: rootIds }));
  }
  await measure("category: filtered (brand+ram+price)", () =>
    discover({ params: { brand: "Brand1", ram: "16", min: "1000", max: "15000" }, categoryIds: rootIds }),
  );
  await measure("catalogue: best_selling, whole catalogue", () =>
    catalog.listProductCards({ sort: "best_selling", limit: 24 }),
  );
  await measure("search: wireless headphones", () => discover({ params: { q: "wireless headphones" } }));
  await measure("search: suggest 'hea'", () => suggestSearch("hea"));
  if (liveProduct) {
    const product = await catalog.getPublicProductBySlug(liveProduct.slug);
    if (product) {
      await measure("product: core data", () =>
        Promise.all([
          catalog.getPublicProductBySlug(liveProduct.slug),
          catalog.getPublicVariants(product.id),
          catalog.listRecommendations(product.id, 4),
          catalog.listRelatedProducts(product.id, product.categoryId, 8),
        ]),
      );
    }
  }
  const range = admin.lastDays(30);
  await measure("admin: overview", () =>
    Promise.all([
      admin.getSalesSummary(actor, range),
      admin.getDailySeries(actor, range),
      admin.getWorkQueue(actor),
      admin.getTopProductsInRange(actor, range, 5),
      admin.getStockAlerts(actor, 6),
      admin.getCatalogCounts(actor),
    ]),
  );
  await measure("admin: products list, page 1 (server-paged)", () => searchProductsForAdmin(actor, { pageSize: 50 }));
  await measure("admin: products list, low stock by price", () =>
    searchProductsForAdmin(actor, { stock: "low", sort: "price_asc", pageSize: 50 }),
  );
  await measure("admin: products list, search", () => searchProductsForAdmin(actor, { q: "wireless", pageSize: 50 }));
  await measure("admin: orders page 1", () => searchOrdersForStaff(actor, { limit: 50 }));
  // Newest-first pages by keyset (lib/orders), so the deep page is reached
  // with a real cursor; an offset would be ignored and measure page one.
  const [deep] = (await db.execute(
    sql`select placed_at, id from orders order by placed_at desc, id desc offset 49950 limit 1`,
  )) as unknown as { placed_at: string; id: string }[];
  if (deep) {
    const after = { placedAt: new Date(deep.placed_at), id: deep.id };
    await measure("admin: orders 1,000 pages deep (keyset)", () => searchOrdersForStaff(actor, { limit: 50, after }));
  }
  await measure("admin: orders by total, deep page (offset)", () =>
    searchOrdersForStaff(actor, { limit: 50, offset: 49_950, sort: "total_desc" }),
  );
  await measure("admin: orders search", () => searchOrdersForStaff(actor, { q: "scale123", limit: 50 }));
  await measure("admin: customers page 1", () => listCustomersWithOrders(actor, { limit: 50 }));
  await measure("admin: orders CSV export", () => exportOrdersCsv(actor));

  if (JSON_OUTPUT) console.log(JSON.stringify({ runs: RUNS, results }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
