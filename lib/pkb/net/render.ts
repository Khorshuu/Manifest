import { existsSync } from "node:fs";
import { getLocalServicesConfig } from "@/lib/providers/local/config";
import type { Extraction } from "../extract";
import type { RobotsDecision } from "./robots";
import { checkRobots } from "./robots";
import { KNOWLEDGE_USER_AGENT, safeFetch, vetDestination, type SafeFetchOptions } from "./safe-fetch";

/**
 * Rendering a product page that only shows its content through JavaScript
 * (D-124). Optional, off by default (`LOCAL_BROWSER_RENDERER=playwright`),
 * and used only when the static copy `safeFetch` retrieved is clearly an
 * empty application shell (`needsRendering`). It is slow and expensive, so it
 * is never the first way a page is read.
 *
 * The browser never touches the network itself. That is the whole security
 * design: a browser makes arbitrary subrequests, and each of them is an SSRF
 * opportunity unless it goes through the same checks as everything else.
 *
 *  - Chromium is started with every host name mapped to "not found" and a
 *    dead proxy for anything else (loopback included), so a request that
 *    escaped interception could not connect anywhere.
 *  - Every HTTP request the page makes is intercepted. The page's own
 *    document is answered from the copy `safeFetch` already retrieved. A
 *    script, stylesheet, XHR or fetch is retrieved by `safeFetch` itself —
 *    public addresses only, one vetted DNS answer, redirects re-checked, size
 *    and time capped, no cookies, no credentials — after robots.txt allows it,
 *    and handed to the browser. Anything else (images, media, fonts, frames,
 *    WebSockets, beacons, non-GET requests, navigation away from the page) is
 *    refused.
 *  - A fresh context per page, with service workers blocked, no stored
 *    state, no downloads, dialogs dismissed and pop-ups closed; the context
 *    and the browser are closed when the page is read, whatever happened.
 *  - Nothing is clicked, typed or submitted. A page that answers with a
 *    CAPTCHA or a bot check is reported as such and not used; it is never
 *    solved or worked around.
 *
 * If the runtime or the browser binary is missing, rendering is UNAVAILABLE
 * and the static page is used, with a note that rendering might have helped.
 */

export type RenderOutcome =
  | { ok: true; html: string; url: string; requests: number; refused: number }
  | { ok: false; code: "UNAVAILABLE" | "REFUSED" | "CHALLENGE" | "TIMEOUT" | "FAILED"; reason: string };

export type PageRenderer = {
  readonly key: string;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  render(input: {
    url: string;
    html: string;
    contentType: string;
    robotsCache: Map<string, string | null | "unreachable">;
  }): Promise<RenderOutcome>;
};

// ------------------------------------------------------------- when to render

/**
 * Whether a static copy is an empty shell that JavaScript would fill.
 *
 * Generic on purpose — no site is named. A page is rendered only when all of
 * these hold: it states no product in structured data and gave the readers
 * next to nothing; its visible text is short; and it looks like it depends on
 * scripts — an empty application mount point, a <noscript> asking for
 * JavaScript, or far more script than text. A short but complete page (a
 * small product with a few lines and a JSON-LD Product) is not rendered.
 */
export function needsRendering(html: string, extraction: Extraction): boolean {
  const hasProduct = extraction.structuredData.length > 0 || (extraction.identity.names.length > 0 && extraction.pairs.length >= 3);
  if (hasProduct) return false;
  const text = extraction.text.length;
  if (text >= 1_500) return false;
  const emptyMount = /<(div|main|section)\b[^>]*\bid=["'](root|app|__next|__nuxt|svelte|main-app|application|page-root|react-root|storefront)["'][^>]*>\s*<\/\1>/i.test(html) || /<app-root\b[^>]*>\s*<\/app-root>/i.test(html);
  const noscript = /<noscript\b[^>]*>[\s\S]{0,400}?(enable|turn on|requires?|need)\s+javascript/i.test(html);
  let scriptBytes = 0;
  let scripts = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    scripts += 1;
    scriptBytes += match[2].length + (/\bsrc=/i.test(match[1]) ? 20_000 : 0);
  }
  const scriptHeavy = scripts > 0 && scriptBytes > Math.max(5 * text, 20_000);
  if (text < 600) return emptyMount || noscript || scriptHeavy;
  return (emptyMount || noscript) && scriptHeavy;
}

/** Text a bot check or access wall shows instead of a product. */
export function looksLikeChallenge(text: string): boolean {
  if (text.length > 3_000) return false;
  return /captcha|verify (that )?you are (a )?human|are you a robot|checking your browser|attention required|access denied|unusual traffic|press (&|and) hold|enable cookies to continue/i.test(text);
}

// --------------------------------------------------------------- playwright

export const RENDER_LIMITS = {
  TIMEOUT_MS: 25_000,
  SETTLE_MS: 6_000,
  MAX_REQUESTS: 120,
  MAX_TOTAL_BYTES: 12 * 1024 * 1024,
  MAX_RESOURCE_BYTES: 3 * 1024 * 1024,
  MAX_HTML: 3 * 1024 * 1024,
};

const RESOURCE_TYPES: Record<string, string[]> = {
  script: ["application/javascript", "text/javascript", "application/x-javascript", "application/ecmascript", "text/ecmascript", "application/json"],
  stylesheet: ["text/css"],
  xhr: ["application/json", "application/ld+json", "text/plain", "text/html", "application/graphql-response+json", "application/xml", "text/xml"],
  fetch: ["application/json", "application/ld+json", "text/plain", "text/html", "application/graphql-response+json", "application/xml", "text/xml"],
};

/**
 * Chromium flags that leave it no network of its own: every name resolves to
 * nothing, and everything — loopback included — goes to a proxy that does
 * not exist. Intercepted requests are answered before either matters.
 */
export const ISOLATION_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--dns-prefetch-disable",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--disable-extensions",
  "--disable-default-apps",
  "--no-first-run",
  "--no-pings",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=NetworkPrediction,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication",
];

type PlaywrightModule = typeof import("playwright-core");

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import("playwright-core")) as PlaywrightModule;
  } catch {
    return null;
  }
}

export type PlaywrightRendererOptions = {
  /** Test seams passed through to `safeFetch`. Production passes none. */
  fetchOptions?: Pick<SafeFetchOptions, "resolver" | "addressAllowed" | "allowedPorts">;
  /** Replaces the robots check; production uses robots.txt through `safeFetch`. */
  robots?: (url: string, cache: Map<string, string | null | "unreachable">) => Promise<RobotsDecision>;
  limits?: Partial<typeof RENDER_LIMITS>;
  /** Observes each browser lifecycle, for tests that prove it is closed. */
  onClosed?: () => void;
};

export class PlaywrightRenderer implements PageRenderer {
  readonly key = "playwright";
  private readonly limits: typeof RENDER_LIMITS;

  constructor(private readonly options: PlaywrightRendererOptions = {}) {
    this.limits = { ...RENDER_LIMITS, ...options.limits };
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const playwright = await loadPlaywright();
    if (!playwright) return { ok: false, reason: "the Playwright runtime (playwright-core) is not installed" };
    let executable: string;
    try {
      executable = playwright.chromium.executablePath();
    } catch {
      return { ok: false, reason: "the Chromium browser for Playwright is not installed (run: npx playwright install chromium)" };
    }
    if (!executable || !existsSync(executable)) {
      return { ok: false, reason: "the Chromium browser for Playwright is not installed (run: npx playwright install chromium)" };
    }
    return { ok: true };
  }

  async render(input: Parameters<PageRenderer["render"]>[0]): Promise<RenderOutcome> {
    const ready = await this.available();
    if (!ready.ok) return { ok: false, code: "UNAVAILABLE", reason: ready.reason };
    // Only ever started from an address safeFetch would accept.
    const vetted = await vetDestination(input.url, this.options.fetchOptions);
    if (!vetted.ok) return { ok: false, code: "REFUSED", reason: `the page address is refused: ${vetted.reason}` };
    const playwright = (await loadPlaywright())!;
    const limits = this.limits;
    const deadline = Date.now() + limits.TIMEOUT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    const target = new URL(input.url);
    target.hash = "";
    const robots = this.options.robots ?? ((url, cache) => checkRobots(url, cache, this.options.fetchOptions));

    let requests = 0;
    let refused = 0;
    let bytes = 0;

    let browser: import("playwright-core").Browser | null = null;
    try {
      browser = await playwright.chromium.launch({ headless: true, args: ISOLATION_ARGS, timeout: Math.min(15_000, remaining()) });
      const context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        userAgent: `${KNOWLEDGE_USER_AGENT} (rendering)`,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        permissions: [],
        ignoreHTTPSErrors: false,
      });
      await context.routeWebSocket(() => true, (socket) => socket.close({ code: 1008, reason: "not allowed" }));
      const page = await context.newPage();
      context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => undefined);
      });
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));

      await context.route("**/*", async (route) => {
        const request = route.request();
        requests += 1;
        const refuse = async () => {
          refused += 1;
          await route.abort("blockedbyclient").catch(() => undefined);
        };
        if (requests > limits.MAX_REQUESTS || remaining() < 500) return refuse();
        let url: URL;
        try {
          url = new URL(request.url());
        } catch {
          return refuse();
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return refuse();
        if (request.method() !== "GET") return refuse();
        const type = request.resourceType();

        if (type === "document") {
          const mainFrame = request.frame() === page.mainFrame();
          const same = `${url.origin}${url.pathname}${url.search}` === `${target.origin}${target.pathname}${target.search}`;
          if (!mainFrame || !same || !request.isNavigationRequest()) return refuse();
          await route
            .fulfill({ status: 200, contentType: `${input.contentType}; charset=utf-8`, body: input.html })
            .catch(() => undefined);
          return;
        }
        const accept = RESOURCE_TYPES[type];
        if (!accept) return refuse();

        const decision = await robots(url.toString(), input.robotsCache).catch(() => ({ allowed: false, reason: "robots check failed" }));
        if (!decision.allowed) return refuse();
        const fetched = await safeFetch(url.toString(), {
          ...this.options.fetchOptions,
          acceptTypes: accept,
          maxBytes: Math.min(limits.MAX_RESOURCE_BYTES, Math.max(1, limits.MAX_TOTAL_BYTES - bytes)),
          timeoutMs: Math.max(500, Math.min(10_000, remaining())),
          userAgent: `${KNOWLEDGE_USER_AGENT} (rendering)`,
        });
        if (!fetched.ok) return refuse();
        bytes += fetched.body.byteLength;
        if (bytes > limits.MAX_TOTAL_BYTES) return refuse();
        await route
          .fulfill({
            status: fetched.status,
            contentType: fetched.charset ? `${fetched.contentType}; charset=${fetched.charset}` : fetched.contentType,
            // Retrieved without cookies or credentials, so it is public either way;
            // this lets the page's own script read what safeFetch already could.
            headers: type === "xhr" || type === "fetch" ? { "access-control-allow-origin": target.origin } : {},
            body: fetched.body,
          })
          .catch(() => undefined);
      });

      try {
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: Math.max(1_000, remaining()) });
      } catch {
        return { ok: false, code: remaining() <= 0 ? "TIMEOUT" : "FAILED", reason: "the page could not be rendered" };
      }
      await page.waitForLoadState("networkidle", { timeout: Math.max(500, Math.min(limits.SETTLE_MS, remaining())) }).catch(() => undefined);

      const visible = await page.evaluate(() => document.body?.innerText?.slice(0, 5_000) ?? "").catch(() => "");
      if (looksLikeChallenge(visible)) {
        return { ok: false, code: "CHALLENGE", reason: "the site answered with a bot check or CAPTCHA, which is not worked around" };
      }
      const html = await page.content();
      if (html.length > limits.MAX_HTML) return { ok: false, code: "FAILED", reason: "the rendered page was larger than allowed" };
      return { ok: true, html, url: target.toString(), requests, refused };
    } catch {
      return { ok: false, code: remaining() <= 0 ? "TIMEOUT" : "FAILED", reason: remaining() <= 0 ? "rendering took too long" : "the browser could not render the page" };
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
        this.options.onClosed?.();
      }
    }
  }
}

// ---------------------------------------------------------------- selection

let override: PageRenderer | null | undefined;

/** The configured renderer, or null when browser rendering is off. */
export async function getPageRenderer(): Promise<PageRenderer | null> {
  if (override !== undefined) return override;
  return getLocalServicesConfig().LOCAL_BROWSER_RENDERER === "playwright" ? new PlaywrightRenderer() : null;
}

/** Test helper: `null` forces "not configured"; `undefined` restores the default. */
export function setPageRendererForTesting(renderer: PageRenderer | null | undefined): void {
  override = renderer;
}
