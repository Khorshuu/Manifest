/**
 * Times a whole-catalogue search reindex against a scale database (risk R-12).
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/manifest_scale \
 *     npx tsx scripts/perf/search-rebuild-bench.ts [--json]
 *
 * Stage 5 measured `refresh_product_search` at about 43 ms a listing, so a
 * 5,000-listing rebuild was roughly 71 seconds — and Stage 6 left that work
 * inside the admin request that asked for it, where no serverless platform
 * would let it finish and nothing could resume it if it failed half-way.
 *
 * Stage 7 splits the two numbers, and this script reports both:
 *
 *  - **What the request costs.** `rebuildSearchIndex` now queues and returns.
 *    That figure should be a small number of milliseconds and should not grow
 *    with the cost of reindexing, only with the catalogue's size.
 *  - **What the draining costs.** The same total work, in bounded chunks that
 *    a background worker can stop and resume. This does not get faster; the
 *    point is that it is no longer inside a web request.
 *
 * It writes only to the queue and the index, both of which are derived data,
 * and it refuses anything that is not a scratch database.
 */
import "../../lib/load-env";
import { sql } from "drizzle-orm";
import { assertScratchDatabase } from "../../db/scratch-guard";

assertScratchDatabase(process.env.DATABASE_URL);

const JSON_OUTPUT = process.argv.includes("--json");

function ms(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function main() {
  const { db } = await import("../../db");
  const { rebuildSearchIndex, processSearchQueue, searchIndexStatus } = await import(
    "../../lib/search/maintenance"
  );

  const [{ n: products }] = (await db.execute(sql`select count(*)::int as n from products`)) as unknown as [
    { n: number },
  ];

  // A stand-in for the signed-in member of staff who presses the button. The
  // permission check is the same one the route runs.
  const [owner] = (await db.execute(
    sql`select id, email, role from users where role = 'super_admin' limit 1`,
  )) as unknown as [{ id: string; email: string; role: "super_admin" } | undefined];
  if (!owner) throw new Error("The scale database has no super_admin to act as.");
  const actor = { id: owner.id, email: owner.email, role: owner.role };

  // Start from an empty queue, so the request figure is the cost of queueing
  // the catalogue rather than of whatever was already waiting.
  await db.execute(sql`delete from product_search_queue`);

  const queueStarted = process.hrtime.bigint();
  const requested = await rebuildSearchIndex(actor);
  const requestMs = ms(queueStarted);

  const status = await searchIndexStatus(actor);

  // Drain it, one worker, measuring each pass. `continueWhenMore` is off: a
  // background worker would enqueue its successor, and here the loop is the
  // successor.
  const passes: { rebuilt: number; remaining: number; ms: number }[] = [];
  const drainStarted = process.hrtime.bigint();
  for (;;) {
    const passStarted = process.hrtime.bigint();
    const pass = await processSearchQueue({ limit: 1_000, budgetMs: 120_000, continueWhenMore: false });
    if (pass.rebuilt === 0 && pass.failed === 0) break;
    passes.push({ rebuilt: pass.rebuilt, remaining: pass.remaining, ms: ms(passStarted) });
    if (pass.remaining === 0 || pass.failed > 0) break;
  }
  const drainMs = ms(drainStarted);

  // The other half of the R-12 figure: what one listing costs on its own, which
  // is what the deferred trigger pays when somebody saves a product. The
  // catalogue rebuild never pays this, because it refreshes in batches of 200
  // and the per-call overhead is amortised — the gap between the two numbers is
  // the whole reason the rebuild is chunked.
  const [single] = (await db.execute(sql`select id from products limit 1`)) as unknown as [{ id: string }];
  const singleSamples: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    const at = process.hrtime.bigint();
    await db.execute(sql`select refresh_product_search(array[${single.id}]::uuid[])`);
    singleSamples.push(ms(at));
  }
  singleSamples.sort((a, b) => a - b);

  const rebuilt = passes.reduce((sum, pass) => sum + pass.rebuilt, 0);
  const report = {
    products,
    queued: requested.queued,
    requestMs: Number(requestMs.toFixed(1)),
    drainMs: Number(drainMs.toFixed(1)),
    perListingMs: rebuilt > 0 ? Number((drainMs / rebuilt).toFixed(2)) : null,
    singleListingMs: Number(singleSamples[Math.floor(singleSamples.length / 2)].toFixed(2)),
    passes: passes.length,
    rebuilt,
    missingAfter: (await searchIndexStatus(actor)).missing,
    queuedAfter: (await searchIndexStatus(actor)).queued,
    indexedBefore: status.indexed,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Catalogue: ${report.products} listings`);
    console.log(`Request (queue and return):   ${report.requestMs} ms  — ${report.queued} queued`);
    console.log(`Background drain (one worker): ${report.drainMs} ms over ${report.passes} pass(es)`);
    console.log(`Per listing, in the drain:    ${report.perListingMs} ms`);
    console.log(`Per listing, one at a time:   ${report.singleListingMs} ms  — what a product save pays`);
    console.log(`Left afterwards:              ${report.queuedAfter} queued, ${report.missingAfter} missing`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
