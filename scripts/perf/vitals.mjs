/**
 * Mobile Core Web Vitals in a lab (PRODUCTION-READINESS 13.1).
 *
 *   node scripts/perf/vitals.mjs --base http://localhost:3100 --runs 3 \
 *     --paths "/,/cart" [--variant <uuid>] [--warm] [--json out.json]
 *
 * Loads each page in Chromium as a mid-range phone on a slow connection —
 * 412 × 915 at DPR 2.625, CPU slowed 4×, "Slow 4G" (150 ms RTT, 1.6 Mbps down,
 * 750 kbps up) — and reports the median over --runs of:
 *
 * - server response start (emulated latency is not included in navigation
 *   timing, so this is the server part only) and FCP;
 * - LCP, from `largest-contentful-paint` entries, with the element it chose;
 * - CLS, as the largest session window of `layout-shift` entries without
 *   recent input — measured while the page is scrolled to the bottom and back,
 *   so content that arrives below the fold counts too;
 * - TBT, the sum of long-task time over 50 ms after FCP (the lab stand-in for
 *   responsiveness), and the longest single task;
 * - a tap's slowest `event` timing entry (an INP stand-in) on --tap, a CSS
 *   selector, when it is on the page;
 * - bytes transferred by type (document, script, image, font, other), request
 *   count, and the three largest images with their transfer size.
 *
 * Cold by default: every run is a fresh browser context with an empty cache.
 * --warm loads the page once in the context before measuring, so the second
 * load is what a returning visitor gets. --variant puts one of that variant in
 * the cart first, so /cart and /checkout show a real line. --login email:password
 * signs in first, for staff pages.
 *
 * Lab figures are not field data. They compare a change against the same page
 * before it, on the same machine.
 */
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) {
      const next = all[index + 1];
      pairs.push([value.slice(2), next === undefined || next.startsWith("--") ? "1" : next]);
    }
    return pairs;
  }, []),
);
const base = args.base ?? "http://localhost:3100";
const runs = Number(args.runs ?? 3);
const paths = (args.paths ?? "/").split(",");
const tap = args.tap ?? "header button";
const warm = args.warm === "1";

const OBSERVE = `
  window.__vitals = { lcp: 0, lcpElement: "", cls: 0, longTasks: [], events: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__vitals.lcp = entry.startTime;
      const el = entry.element;
      window.__vitals.lcpElement = el
        ? el.tagName.toLowerCase() + (el.getAttribute("alt") !== null ? "[alt]" : "") + " " +
          (el.currentSrc || el.textContent || "").trim().replace(/^https?:\\/\\/[^/]+/, "").slice(0, 60)
        : "";
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  let session = 0, last = 0, first = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      if (session && entry.startTime - last < 1000 && entry.startTime - first < 5000) session += entry.value;
      else { session = entry.value; first = entry.startTime; }
      last = entry.startTime;
      window.__vitals.cls = Math.max(window.__vitals.cls, session);
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__vitals.longTasks.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__vitals.events.push(entry.duration);
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
`;

const median = (values) => {
  const sorted = values.filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const kb = (bytes) => Math.round(bytes / 1024);

const browser = await chromium.launch();
const results = [];

async function measure(path) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();

  if (args.login) {
    const [email, ...rest] = args.login.split(":");
    const response = await page.request.post(`${base}/api/auth/login`, {
      data: { email, password: rest.join(":") },
      headers: { origin: base },
    });
    if (!response.ok()) throw new Error(`could not sign in: ${response.status()}`);
  }
  if (args.variant) {
    const response = await page.request.post(`${base}/api/cart`, {
      data: { variantId: args.variant, quantity: 1 },
      headers: { origin: base },
    });
    if (!response.ok()) throw new Error(`could not add to cart: ${response.status()}`);
  }
  if (warm) await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (!warm) await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const requests = new Map();
  cdp.on("Network.responseReceived", ({ requestId, type, response }) => {
    requests.set(requestId, { type, url: response.url, bytes: 0 });
  });
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const entry = requests.get(requestId);
    if (entry) entry.bytes = encodedDataLength;
  });

  await page.addInitScript(OBSERVE);
  await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(2000);

  // LCP is read before scrolling: a scripted scroll is not input, so the
  // browser would keep reporting images revealed further down as candidates.
  const lcp = await page.evaluate(() => ({ lcp: window.__vitals.lcp, lcpElement: window.__vitals.lcpElement }));

  // Scroll to the bottom and back, so lazy images load and late shifts count.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);

  let tapMs = null;
  const target = page.locator(tap).first();
  if (await target.isVisible().catch(() => false)) {
    await page.evaluate(() => (window.__vitals.events = []));
    await target.tap({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    tapMs = await page.evaluate(() => (window.__vitals.events.length ? Math.max(...window.__vitals.events) : 0));
  }

  const sample = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const tasks = window.__vitals.longTasks.filter(([start]) => start >= fcp);
    return {
      server: nav.responseStart,
      fcp,
      cls: window.__vitals.cls,
      tbt: tasks.reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0),
      longestTask: tasks.reduce((max, [, duration]) => Math.max(max, duration), 0),
    };
  });

  const byType = { Document: 0, Script: 0, Image: 0, Font: 0, other: 0 };
  const images = [];
  for (const entry of requests.values()) {
    const key = entry.type in byType ? entry.type : "other";
    byType[key] += entry.bytes;
    if (entry.type === "Image") images.push(entry);
  }
  images.sort((a, b) => b.bytes - a.bytes);

  await context.close();
  return {
    ...sample,
    ...lcp,
    tapMs,
    requests: requests.size,
    htmlKb: kb(byType.Document),
    jsKb: kb(byType.Script),
    imageKb: kb(byType.Image),
    fontKb: kb(byType.Font),
    otherKb: kb(byType.other),
    largestImages: images.slice(0, 3).map((image) => `${kb(image.bytes)}KB ${decodeURIComponent(image.url.replace(base, "")).slice(0, 90)}`),
  };
}

for (const path of paths) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) samples.push(await measure(path));
  const pick = (key) => median(samples.map((sample) => sample[key]));
  const row = {
    path,
    warm,
    server: Math.round(pick("server")),
    fcp: Math.round(pick("fcp")),
    lcp: Math.round(pick("lcp")),
    cls: Number(pick("cls").toFixed(3)),
    tbt: Math.round(pick("tbt")),
    longestTask: Math.round(pick("longestTask")),
    tapMs: pick("tapMs"),
    requests: pick("requests"),
    htmlKb: pick("htmlKb"),
    jsKb: pick("jsKb"),
    imageKb: pick("imageKb"),
    fontKb: pick("fontKb"),
    lcpElement: samples.at(-1).lcpElement,
    largestImages: samples.at(-1).largestImages,
  };
  results.push(row);
  console.log(
    `${path}${warm ? " (warm)" : ""} | LCP ${row.lcp} | CLS ${row.cls} | TBT ${row.tbt} (longest ${row.longestTask}) | tap ${row.tapMs ?? "-"} | FCP ${row.fcp} | server ${row.server}` +
      ` | ${row.requests} req | html ${row.htmlKb}KB js ${row.jsKb}KB img ${row.imageKb}KB font ${row.fontKb}KB\n    LCP element: ${row.lcpElement}\n    largest images: ${row.largestImages.join(" · ")}`,
  );
}

await browser.close();
if (args.json) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.json, JSON.stringify(results, null, 2));
}
