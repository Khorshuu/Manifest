/**
 * Performance budgets as a pass/fail check (PRODUCTION-READINESS 23.1).
 *
 *   node scripts/perf/budget.mjs --base http://localhost:3000 \
 *     [--paths "/,/cart"] [--js 170] [--html 60]
 *
 * For each page: first-load JavaScript (every <script src> except the
 * legacy `noModule` polyfills, gzipped) must be at most --js KB, and the HTML
 * document, gzipped, at most --html KB. Prints a table and exits 1 if any page
 * is over, so CI fails instead of a regression passing silently.
 */
import { gzipSync } from "node:zlib";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = option("base", "http://localhost:3000");
const jsBudget = Number(option("js", "170"));
const htmlBudget = Number(option("html", "60"));
const paths = option(
  "paths",
  "/,/categories/candy-chocolate,/search?q=candy,/products/seasonal-candy-variety-box,/cart,/login",
).split(",");

const scripts = new Map();

async function javascriptKb(html) {
  const sources = [
    ...new Set(
      [...html.matchAll(/<script([^>]*)>/g)]
        .filter((match) => !/\bnomodule\b/i.test(match[1]))
        .map((match) => /src="([^"]+)"/.exec(match[1])?.[1])
        .filter(Boolean),
    ),
  ];
  let bytes = 0;
  for (const source of sources) {
    if (!scripts.has(source)) {
      const response = await fetch(new URL(source, base));
      scripts.set(source, gzipSync(await response.text()).length);
    }
    bytes += scripts.get(source);
  }
  return Math.round(bytes / 1024);
}

let failed = false;
for (const path of paths) {
  const response = await fetch(base + path);
  const html = await response.text();
  const js = await javascriptKb(html);
  const htmlKb = Math.round(gzipSync(html).length / 1024);
  const over = [];
  if (response.status >= 400) over.push(`status ${response.status}`);
  if (js > jsBudget) over.push(`JS ${js} KB > ${jsBudget} KB`);
  if (htmlKb > htmlBudget) over.push(`HTML ${htmlKb} KB > ${htmlBudget} KB`);
  if (over.length) failed = true;
  console.log(`${over.length ? "OVER" : "ok  "}  ${path.padEnd(42)} js ${String(js).padStart(4)} KB  html ${String(htmlKb).padStart(3)} KB${over.length ? `  — ${over.join("; ")}` : ""}`);
}

if (failed) {
  console.error(`\nBudget exceeded (JavaScript ${jsBudget} KB, HTML ${htmlBudget} KB gzip).`);
  process.exit(1);
}
