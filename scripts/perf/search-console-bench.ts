/**
 * Times the opportunity engine against a representative Search Console volume
 * (risk R-16).
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/manifest_bench \
 *     npx tsx scripts/perf/search-console-bench.ts [--pages 20000] [--json]
 *
 * Stage 6 shipped the engine having only ever run it against this shop's own
 * development data — a few dozen rows. Its limits are 500 pages and 500
 * page-and-query rows per window, most-shown first, so the question the tracker
 * asked was whether a property with tens of thousands of addresses makes it
 * slow or merely makes it partial.
 *
 * This writes measurements for `--pages` distinct addresses across a 28-day
 * window and asks for the report. The two figures that matter are the time and
 * the coverage: the report must say what it left out, and it must not get
 * slower as the property grows, because the limits are what keep the read
 * bounded.
 *
 * It writes only to `search_console_metrics`, which is a copy of what Google
 * reported, and refuses anything that is not a scratch database.
 */
import "../../lib/load-env";
import { sql } from "drizzle-orm";
import { assertScratchDatabase } from "../../db/scratch-guard";

assertScratchDatabase(process.env.DATABASE_URL);

/*
 * The engine reads the configured property, so the bench has to look
 * configured. Nothing here calls Google: `opportunityReport` only reads the
 * measurements table, and the key below exists so `connection()` answers
 * CONFIGURED rather than NOT_CONFIGURED.
 */
const PROPERTY = "sc-domain:manifest.bench";
process.env.SEARCH_CONSOLE_PROVIDER = "google";
process.env.SEARCH_CONSOLE_SITE_URL = PROPERTY;
process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL ??= "bench@example-project.iam.gserviceaccount.com";
process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY ??=
  "-----BEGIN PRIVATE KEY-----\\nbench\\n-----END PRIVATE KEY-----";

const pagesFlag = process.argv.indexOf("--pages");
const PAGES = pagesFlag === -1 ? 20_000 : Math.max(100, Number(process.argv[pagesFlag + 1]) || 20_000);
const JSON_OUTPUT = process.argv.includes("--json");
const DAYS = 28;

function ms(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function main() {
  const { db } = await import("../../db");
  const { opportunityReport } = await import("../../lib/search-console/opportunities");

  const [owner] = (await db.execute(
    sql`select id, email, role from users where role = 'super_admin' limit 1`,
  )) as unknown as [{ id: string; email: string; role: "super_admin" } | undefined];
  if (!owner) throw new Error("The scale database has no super_admin to act as.");
  const actor = { id: owner.id, email: owner.email, role: owner.role };

  const [{ n: already }] = (await db.execute(
    sql`select count(*)::int as n from search_console_metrics where property = ${PROPERTY}`,
  )) as unknown as [{ n: number }];

  const wanted = PAGES * DAYS;
  if (already < wanted) {
    process.stdout.write(`Writing ${wanted.toLocaleString("en-GB")} measurements…\n`);
    await db.execute(sql`delete from search_console_metrics where property = ${PROPERTY}`);
    // Two windows' worth, so the before-and-after comparison has both sides.
    await db.execute(sql`
      insert into search_console_metrics
        (property, measured_on, dimension, page_path, query, query_key, clicks, impressions, position)
      select ${PROPERTY},
             (current_date - (d || ' days')::interval)::date,
             'page',
             '/products/bench-' || p,
             '', '',
             (p % 7),
             10 + (p % 500),
             1 + ((p * 7 + d) % 40)
      from generate_series(1, ${PAGES}) p, generate_series(1, ${DAYS * 2}) d
      on conflict do nothing
    `);
    await db.execute(sql`analyze search_console_metrics`);
  }

  const [{ n: rows }] = (await db.execute(
    sql`select count(*)::int as n from search_console_metrics where property = ${PROPERTY}`,
  )) as unknown as [{ n: number }];
  const [{ n: distinct }] = (await db.execute(
    sql`select count(distinct page_path)::int as n from search_console_metrics where property = ${PROPERTY}`,
  )) as unknown as [{ n: number }];

  // Warm, then measure.
  await opportunityReport(actor).catch(() => undefined);
  const samples: number[] = [];
  let report: Awaited<ReturnType<typeof opportunityReport>> | null = null;
  for (let run = 0; run < 5; run += 1) {
    const at = process.hrtime.bigint();
    report = await opportunityReport(actor);
    samples.push(ms(at));
  }
  samples.sort((a, b) => a - b);

  const result = {
    measurements: rows,
    distinctPages: distinct,
    p50: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
    p95: Number(samples[samples.length - 1].toFixed(1)),
    coverage: report?.coverage,
    opportunities: report?.opportunities.length ?? 0,
    improvements: report?.improvements.length ?? 0,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.measurements.toLocaleString("en-GB")} measurements over ${result.distinctPages.toLocaleString("en-GB")} pages`,
    );
    console.log(`opportunityReport   p50 ${result.p50} ms   p95 ${result.p95} ms`);
    console.log(
      `covered             ${result.coverage?.pagesConsidered} of ${result.coverage?.pagesAvailable} page(s)` +
        `${result.coverage?.pagesTruncated ? " — reported as partial" : ""}`,
    );
    console.log(`findings            ${result.opportunities} to do, ${result.improvements} improved`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
