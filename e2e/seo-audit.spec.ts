import { expect, test } from "@playwright/test";

/**
 * The SEO basics on every public page type (PRODUCTION-READINESS 19.1): a
 * specific title, a meta description, exactly one h1, a canonical address,
 * Open Graph title, the right robots directive, the page language and a
 * viewport. Pages that are not landing pages — search results, the cart,
 * checkout, the account area, sign-in — must be kept out of the index.
 */

const INDEXABLE = [
  "/",
  "/categories/candy-chocolate",
  "/products/seasonal-candy-variety-box",
  "/help",
];

const NOT_INDEXED = ["/search?q=candy", "/cart", "/checkout", "/login", "/register", "/orders/lookup"];

async function readHead(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content") ?? null;
    return {
      title: document.title,
      lang: document.documentElement.lang,
      viewport: meta('meta[name="viewport"]'),
      description: meta('meta[name="description"]'),
      robots: meta('meta[name="robots"]'),
      ogTitle: meta('meta[property="og:title"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      h1s: document.querySelectorAll("h1").length,
    };
  });
}

for (const path of INDEXABLE) {
  test(`${path} carries complete search metadata and is indexable`, async ({ page }) => {
    await page.goto(path);
    const head = await readHead(page);

    expect(head.lang, "lang").toBe("en");
    expect(head.viewport, "viewport").toContain("width=device-width");
    expect(head.title.length, "title").toBeGreaterThan(10);
    expect(head.description?.length ?? 0, "description").toBeGreaterThan(40);
    expect(head.h1s, "exactly one h1").toBe(1);
    expect(head.canonical, "canonical").toMatch(/^https?:\/\//);
    expect(new URL(head.canonical!).pathname, "canonical path").toBe(new URL(path, "http://x").pathname);
    expect(head.ogTitle, "og:title").toBeTruthy();
    expect(head.robots ?? "", "robots").not.toContain("noindex");
  });
}

for (const path of NOT_INDEXED) {
  test(`${path} is kept out of the index`, async ({ page }) => {
    await page.goto(path);
    // An empty checkout sends the shopper to the cart from inside the stream;
    // read the page they end up on.
    await page.waitForLoadState("networkidle");
    const head = await readHead(page);
    expect(head.lang, "lang").toBe("en");
    expect(head.viewport, "viewport").toContain("width=device-width");
    expect(head.robots ?? "", "robots").toContain("noindex");
  });
}

test("titles differ between pages of different kinds", async ({ page }) => {
  const titles = new Set<string>();
  for (const path of INDEXABLE) {
    await page.goto(path);
    titles.add(await page.title());
  }
  expect(titles.size).toBe(INDEXABLE.length);
});
