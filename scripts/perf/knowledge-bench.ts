/**
 * Times the write paths and the knowledge, SEO and search-performance reads
 * that Stages 2 to 6 added, against a scale database.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/manifest_scale \
 *     npx tsx scripts/perf/knowledge-bench.ts [--runs 7] [--json]
 *
 * `scripts/perf/bench.ts` covers the storefront and the admin lists and is
 * read-only. This one writes — a product save, a variant save, an option
 * rename — so it refuses anything that is not a scratch database, and it puts
 * every value it changes back afterwards.
 *
 * Each path is warmed once, then run `--runs` times; p50/p95/p99 and the
 * number of SQL statements the path issued are reported. The statement count
 * matters more than the milliseconds here: it is what does not change when the
 * machine is busy, and an N+1 shows up in it immediately.
 */
import "../../lib/load-env";
import { sql } from "drizzle-orm";
import { assertScratchDatabase } from "../../db/scratch-guard";

assertScratchDatabase(process.env.DATABASE_URL);

const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag === -1 ? 7 : Math.max(1, Number(process.argv[runsFlag + 1]) || 7);
const JSON_OUTPUT = process.argv.includes("--json");

type Row = { label: string; p50: number; p95: number; p99: number; queries: number; note: string | null };

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const { db, getDb } = await import("../../db");
  const { updateProduct, updateVariant, renameProductOptionValue, listProductOptions } = await import(
    "../../lib/catalog"
  );
  const { syncListingKnowledge, knowledgeReport } = await import("../../lib/pkb");
  const { getProductIntelligence, intelligenceQueue } = await import("../../lib/pkb/intelligence");
  const { staffChange } = await import("../../lib/pkb/common");
  const { seoHealth } = await import("../../lib/seo/health");
  const { listingAudit } = await import("../../lib/seo/audit");
  const { discover } = await import("../../lib/catalog/discovery");
  const { suggestSearch } = await import("../../lib/search/suggest");

  let queries = 0;
  const client = (getDb() as unknown as { $client: { unsafe: (...args: unknown[]) => unknown } }).$client;
  const unsafe = client.unsafe.bind(client);
  client.unsafe = (...args: unknown[]) => {
    queries += 1;
    return unsafe(...args);
  };

  const results: Row[] = [];
  async function measure(label: string, work: (run: number) => Promise<unknown>, note: string | null = null) {
    await work(-1);
    const samples: number[] = [];
    let issued = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const before = queries;
      const started = performance.now();
      await work(run);
      samples.push(performance.now() - started);
      issued = queries - before;
    }
    samples.sort((a, b) => a - b);
    const row = {
      label,
      p50: Math.round(percentile(samples, 50) * 10) / 10,
      p95: Math.round(percentile(samples, 95) * 10) / 10,
      p99: Math.round(percentile(samples, 99) * 10) / 10,
      queries: issued,
      note,
    };
    results.push(row);
    if (!JSON_OUTPUT) {
      console.log(
        `${label.padEnd(46)} p50 ${String(row.p50).padStart(7)}ms  p95 ${String(row.p95).padStart(7)}ms  p99 ${String(row.p99).padStart(7)}ms  queries ${String(row.queries).padStart(4)}${note ? `  ${note}` : ""}`,
      );
    }
  }

  const [owner] = (await db.execute(
    sql`select id, email from users where role = 'super_admin' limit 1`,
  )) as unknown as { id: string; email: string }[];
  if (!owner) throw new Error("No super_admin in this database; run npm run db:seed:scale first.");
  const actor = { id: owner.id, email: owner.email, role: "super_admin" as const };

  const [listing] = (await db.execute(sql`
    select p.id, p.slug, p.details, p.pkb_product_id
    from products p
    where p.pkb_product_id is not null and p.status = 'preorder_open'
    order by p.slug
    limit 1
  `)) as unknown as { id: string; slug: string; details: Record<string, string> | null; pkb_product_id: string }[];
  if (!listing) throw new Error("No published listing with knowledge; run npm run pkb:backfill first.");

  const [variant] = (await db.execute(sql`
    select id, price_bdt from product_variants where product_id = ${listing.id} and archived_at is null limit 1
  `)) as unknown as { id: string; price_bdt: number }[];

  const originalDetails = listing.details ?? {};

  // ---------------------------------------------------------------- writes
  await measure(
    "product save: one detail changed",
    (run) => updateProduct(actor, listing.id, { details: { ...originalDetails, material: run % 2 === 0 ? "Oak" : "Ash" } }),
  );
  await measure("product save: nothing changed", () =>
    updateProduct(actor, listing.id, { details: { ...originalDetails, material: "Oak" } }),
  );
  await measure("product save: no fact columns sent", () => updateProduct(actor, listing.id, { searchable: true }));
  await measure("knowledge sync: one listing, no change", () =>
    db.transaction((tx) => syncListingKnowledge(tx, listing.id, staffChange(actor.id))),
  );
  if (variant) {
    await measure("variant save: price changed", (run) =>
      updateVariant(actor, variant.id, { priceBdt: Number(variant.price_bdt) + (run % 2) }),
    );
  }

  const options = await listProductOptions(listing.id);
  const optionValue = options[0]?.values[0];
  if (optionValue) {
    await measure("option value rename (attributed path)", (run) =>
      renameProductOptionValue(actor, optionValue.id, run % 2 === 0 ? `${optionValue.value} ` .trim() + "!" : optionValue.value),
    );
    await renameProductOptionValue(actor, optionValue.id, optionValue.value).catch(() => undefined);
  }

  // ----------------------------------------------------------------- reads
  await measure("intelligence: one product", () => getProductIntelligence(actor, listing.pkb_product_id));
  await measure("intelligence: the queue", () => intelligenceQueue(actor, { limit: 50 }));
  await measure("SEO Health Center", () => seoHealth(actor));
  await measure("SEO page audit: one listing", () => listingAudit(actor, { productId: listing.id, title: listing.slug }));
  await measure("storefront search: 'wireless headphones'", () => discover({ params: { q: "wireless headphones" } }));
  await measure("autocomplete: 'hea'", () => suggestSearch("hea"));
  await measure("knowledge reconciliation report", () => knowledgeReport());

  // Put the listing back the way it was found.
  await updateProduct(actor, listing.id, { details: originalDetails });

  if (JSON_OUTPUT) console.log(JSON.stringify({ runs: RUNS, results }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
