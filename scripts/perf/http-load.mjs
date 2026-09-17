/**
 * HTTP latency, throughput and page weight against a running server.
 *
 *   node scripts/perf/http-load.mjs --base http://localhost:3100 \
 *     --concurrency 20 --requests 100 [--db postgres://…/manifest_scale] \
 *     [--paths /,/search?q=wireless] [--json]
 *
 * For each path: one warm-up request, 10 serial requests, then `--requests`
 * requests shared across `--concurrency` clients. Reports p50/p95/p99,
 * first byte (headers, which arrive with a streamed page's shell),
 * requests per second, error rate (non-2xx/3xx or network failure), HTML size
 * raw and gzipped, and first-load JavaScript (every <script src> on the page,
 * gzipped). With --db it samples pg_stat_activity during the concurrent phase
 * and reports the peak number of connections to that database.
 */
import { gzipSync } from "node:zlib";
import postgres from "postgres";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = option("base", "http://localhost:3000");
const concurrency = Number(option("concurrency", "20"));
const total = Number(option("requests", "100"));
const databaseUrl = option("db", undefined);
const asJson = process.argv.includes("--json");
const paths = option(
  "paths",
  "/,/categories/root-1,/search?q=wireless,/products/p-1001,/cart,/sitemap.xml",
).split(",");

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/* A Vercel deployment behind Deployment Protection (staging) needs the
   automation bypass secret on every request (docs/STAGING.md). */
const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
  : {};

async function hit(path) {
  const started = performance.now();
  try {
    const response = await fetch(base + path, { redirect: "manual", headers });
    // Headers arrive with the first flushed bytes: for a streamed page, the shell.
    const firstByteMs = performance.now() - started;
    const body = await response.text();
    return { ok: response.status < 400, status: response.status, ms: performance.now() - started, firstByteMs, body };
  } catch {
    return { ok: false, status: 0, ms: performance.now() - started, firstByteMs: 0, body: "" };
  }
}

const scripts = new Map();
async function javascriptWeight(html) {
  // `noModule` scripts are the legacy polyfills: browsers that run modules
  // never download them, so counting them overstated every page by ~39 KB.
  const sources = [
    ...new Set(
      [...html.matchAll(/<script([^>]*)>/g)]
        .filter((match) => !/\bnomodule\b/i.test(match[1]))
        .map((match) => /src="([^"]+)"/.exec(match[1])?.[1])
        .filter(Boolean),
    ),
  ];
  let gz = 0;
  for (const source of sources) {
    if (!scripts.has(source)) {
      const text = await (await fetch(new URL(source, base), { headers })).text();
      scripts.set(source, gzipSync(text).length);
    }
    gz += scripts.get(source);
  }
  return { files: sources.length, gzipKb: Math.round(gz / 1024) };
}

const sampler = databaseUrl ? postgres(databaseUrl, { max: 1, onnotice: () => {} }) : null;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : null;

const report = [];
for (const path of paths) {
  await hit(path);

  const serial = [];
  let sample;
  for (let i = 0; i < 10; i += 1) {
    sample = await hit(path);
    serial.push(sample.ms);
  }

  const concurrent = [];
  const firstBytes = [];
  let errors = 0;
  let peakConnections = 0;
  let sampling = Boolean(sampler);
  const sampleLoop = (async () => {
    while (sampling) {
      const [row] = await sampler`select count(*)::int as n from pg_stat_activity where datname = ${databaseName}`;
      peakConnections = Math.max(peakConnections, row.n);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  let remaining = total;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (remaining > 0) {
        remaining -= 1;
        const result = await hit(path);
        concurrent.push(result.ms);
        firstBytes.push(result.firstByteMs);
        if (!result.ok) errors += 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  sampling = false;
  await sampleLoop;

  const isPage = sample.status === 200 && !path.endsWith(".xml");
  const row = {
    path,
    status: sample.status,
    serialP50: Math.round(percentile(serial, 50)),
    p50: Math.round(percentile(concurrent, 50)),
    p95: Math.round(percentile(concurrent, 95)),
    p99: Math.round(percentile(concurrent, 99)),
    firstByteP50: Math.round(percentile(firstBytes, 50)),
    firstByteP95: Math.round(percentile(firstBytes, 95)),
    rps: Number((concurrent.length / seconds).toFixed(1)),
    errorRate: Number((errors / concurrent.length).toFixed(3)),
    htmlKb: Math.round(Buffer.byteLength(sample.body) / 1024),
    htmlGzipKb: Math.round(gzipSync(sample.body).length / 1024),
    js: isPage ? await javascriptWeight(sample.body) : null,
    peakConnections: sampler ? peakConnections : null,
  };
  report.push(row);

  if (!asJson) {
    console.log(
      `${path.padEnd(36)} ${row.status} serial p50 ${row.serialP50}ms | c=${concurrency} p50 ${row.p50} p95 ${row.p95} p99 ${row.p99}ms first byte p50 ${row.firstByteP50} p95 ${row.firstByteP95}ms ${row.rps} req/s err ${(row.errorRate * 100).toFixed(1)}% | html ${row.htmlKb}KB (${row.htmlGzipKb} gz)` +
        (row.js ? ` | js ${row.js.gzipKb}KB gz in ${row.js.files}` : "") +
        (row.peakConnections === null ? "" : ` | db conns ≤${row.peakConnections}`),
    );
  }
}

if (asJson) console.log(JSON.stringify({ base, concurrency, requests: total, report }, null, 2));
await sampler?.end();
