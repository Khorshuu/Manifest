/**
 * D-124: the optional browser renderer, against a controlled local fixture.
 *
 * A real headless Chromium renders a JavaScript-only product page served on
 * 127.0.0.2 under a test host name. The page's scripts also try every way a
 * browser could reach an internal address — fetch, an image, a preconnect, a
 * WebSocket, a beacon, an iframe and a navigation to a "secret" server on
 * 127.0.0.1. The secret server counts connections; it must see none.
 *
 * Skipped when Playwright's Chromium is not installed on this machine.
 */
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractDocument } from "@/lib/pkb/extract";
import { ISOLATION_ARGS, looksLikeChallenge, needsRendering, PlaywrightRenderer } from "@/lib/pkb/net/render";

let chromiumReady = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  chromiumReady = existsSync(chromium.executablePath());
} catch {
  chromiumReady = false;
}

let shop: http.Server;
let secret: net.Server;
let port = 0;
let secretPort = 0;
let secretHits = 0;
const served: string[] = [];

const SHELL = (extra = "") => `<!doctype html><html><head><title>Loading…</title>
<link rel="preconnect" href="http://127.0.0.1:SECRET">
<script src="/app.js" defer></script>${extra}</head>
<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
<img src="http://127.0.0.1:SECRET/pixel.gif"></body></html>`;

const APP_JS = `
(async () => {
  const leak = (url) => fetch(url).catch(() => null);
  leak("http://127.0.0.1:SECRET/secret");
  leak("http://localhost:SECRET/secret");
  leak("http://internal.example.com:PORT/secret");
  leak("/redirect-loop");
  try { new WebSocket("ws://127.0.0.1:SECRET/ws"); } catch (e) {}
  try { navigator.sendBeacon("http://127.0.0.1:SECRET/beacon", "x"); } catch (e) {}
  const frame = document.createElement("iframe"); frame.src = "http://127.0.0.1:SECRET/frame"; document.body.appendChild(frame);
  fetch("/api/post", { method: "POST", body: "x" }).catch(() => null);
  const data = await (await fetch("/api/product.json")).json();
  const root = document.getElementById("root");
  root.innerHTML = "<h1>" + data.name + "</h1><table>" + data.specs.map(([k, v]) => "<tr><th>" + k + "</th><td>" + v + "</td></tr>").join("") + "</table>";
  const ld = document.createElement("script"); ld.type = "application/ld+json";
  ld.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: data.name, brand: { "@type": "Brand", name: "Aurel" } });
  document.head.appendChild(ld);
})();`;

const PRODUCT = {
  name: "Aurel Hydra Serum 30 ml",
  specs: [
    ["Volume", "30 ml"],
    ["Skin type", "All skin types"],
    ["Key ingredient", "Hyaluronic acid"],
  ],
};

function fill(text: string) {
  return text.replaceAll("SECRET", String(secretPort)).replaceAll("PORT", String(port));
}

beforeAll(async () => {
  secret = net.createServer((socket) => {
    secretHits += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => secret.listen(0, "127.0.0.1", resolve));
  secretPort = (secret.address() as AddressInfo).port;

  shop = http.createServer((request, response) => {
    served.push(`${request.method} ${request.url}`);
    const send = (type: string, body: string, status = 200) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    switch (request.url) {
      case "/app.js":
        return send("application/javascript", fill(APP_JS));
      case "/api/product.json":
        return send("application/json", JSON.stringify(PRODUCT));
      case "/redirect-loop":
        response.writeHead(302, { location: "/redirect-loop" });
        return response.end();
      default:
        return send("text/plain", "not here", 404);
    }
  });
  await new Promise<void>((resolve) => shop.listen(0, "127.0.0.2", resolve));
  port = (shop.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => shop?.close(resolve));
  await new Promise((resolve) => secret?.close(resolve));
});

function renderer(onClosed?: () => void) {
  return new PlaywrightRenderer({
    fetchOptions: {
      resolver: async (host) =>
        host === "shop.example.com"
          ? [{ address: "127.0.0.2", family: 4 }]
          : host === "internal.example.com"
            ? [{ address: "127.0.0.1", family: 4 }]
            : [],
      // Only the fixture shop's address is "public" in this test.
      addressAllowed: (address) => address === "127.0.0.2",
      allowedPorts: [port],
    },
    robots: async () => ({ allowed: true, reason: "allowed" }),
    onClosed,
  });
}

describe("when a page is rendered", () => {
  it("renders only a page whose static copy is an empty shell", () => {
    const shell = SHELL();
    expect(needsRendering(shell, extractDocument(shell, "text/html"))).toBe(true);
    const full = `<html><body><h1>Aurel Hydra Serum 30 ml</h1><script type="application/ld+json">{"@type":"Product","name":"Aurel Hydra Serum 30 ml"}</script><table><tr><th>Volume</th><td>30 ml</td></tr></table><p>${"A lightweight serum. ".repeat(20)}</p></body></html>`;
    expect(needsRendering(full, extractDocument(full, "text/html"))).toBe(false);
    // Short, but complete and not script-dependent: read as it is.
    const small = "<html><body><h1>Aurel Lip Balm</h1><p>Shea butter lip balm, 4.5 g.</p></body></html>";
    expect(needsRendering(small, extractDocument(small, "text/html"))).toBe(false);
  });

  it("recognises a bot check instead of a product", () => {
    expect(looksLikeChallenge("Please verify you are a human. Press & Hold")).toBe(true);
    expect(looksLikeChallenge("Aurel Hydra Serum 30 ml — hyaluronic acid serum")).toBe(false);
  });

  it.skipIf(!chromiumReady)(
    "renders the product through safeFetch and never reaches an internal address",
    async () => {
      let closed = 0;
      const url = `http://shop.example.com:${port}/product`;
      const result = await renderer(() => (closed += 1)).render({
        url,
        html: fill(SHELL()),
        contentType: "text/html",
        robotsCache: new Map(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.html).toContain("Aurel Hydra Serum 30 ml");
      expect(result.html).toContain("Hyaluronic acid");
      const extraction = extractDocument(result.html, "text/html", { url });
      expect(extraction.identity.names).toContain("Aurel Hydra Serum 30 ml");
      expect(extraction.pairs.map((pair) => pair.label)).toEqual(expect.arrayContaining(["Volume", "Key ingredient"]));

      // Every leak attempt was refused before any connection was made.
      expect(secretHits).toBe(0);
      expect(result.refused).toBeGreaterThan(0);
      // The document itself was never fetched again by the browser; the POST never left.
      expect(served).not.toContain("GET /product");
      expect(served.some((line) => line.startsWith("POST"))).toBe(false);
      // The redirect loop was followed by safeFetch at most three times, then stopped.
      expect(served.filter((line) => line === "GET /redirect-loop").length).toBeLessThanOrEqual(4);
      expect(closed).toBe(1);
    },
    60_000,
  );

  it.skipIf(!chromiumReady)(
    "does not follow the page when it navigates away",
    async () => {
      let closed = 0;
      const html = `<html><body><div id="root"></div><script>location.href = "http://127.0.0.1:${secretPort}/away";</script><script src="/app.js"></script></body></html>`;
      const result = await renderer(() => (closed += 1)).render({
        url: `http://shop.example.com:${port}/product`,
        html,
        contentType: "text/html",
        robotsCache: new Map(),
      });
      // Either rendered in place or failed; never navigated to the internal address.
      if (result.ok) expect(result.url).toBe(`http://shop.example.com:${port}/product`);
      expect(secretHits).toBe(0);
      expect(closed).toBe(1);
    },
    60_000,
  );

  it.skipIf(!chromiumReady)(
    "refuses a page at an internal address outright",
    async () => {
      const result = await renderer().render({
        url: `http://internal.example.com:${port}/product`,
        html: fill(SHELL()),
        contentType: "text/html",
        robotsCache: new Map(),
      });
      expect(result).toMatchObject({ ok: false, code: "REFUSED" });
      expect(secretHits).toBe(0);
    },
    60_000,
  );

  it.skipIf(!chromiumReady)(
    "starts Chromium with no network of its own, even for a request nothing intercepts",
    async () => {
      // Second line of defence, tested alone: no routing at all, only the launch flags.
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ headless: true, args: ISOLATION_ARGS });
      try {
        const page = await browser.newPage();
        for (const url of [`http://127.0.0.1:${secretPort}/direct`, `http://localhost:${secretPort}/direct`, `http://shop.example.com:${port}/product`]) {
          await expect(page.goto(url, { timeout: 10_000 })).rejects.toThrow();
        }
        const blank = await browser.newPage();
        await blank.evaluate((target) => new Promise((resolve) => {
          const socket = new WebSocket(target);
          socket.onerror = socket.onclose = () => resolve(null);
          setTimeout(() => resolve(null), 2_000);
        }), `ws://127.0.0.1:${secretPort}/ws`);
      } finally {
        await browser.close();
      }
      expect(secretHits).toBe(0);
      expect(served).not.toContain("GET /product");
    },
    60_000,
  );
});
