import { expect, test } from "@playwright/test";

/**
 * SEO and the performance budget.
 *
 * The budget numbers come from docs/DESIGN_GUIDELINES.md. They are measured
 * here rather than asserted in a document nobody checks.
 */

test("the product page carries valid product structured data", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();

  const parsed = blocks.map((block) => JSON.parse(block));
  const product = parsed.find((item) => item["@type"] === "Product");

  expect(product).toBeDefined();
  expect(product.name).toBe("Seasonal Candy Variety Box");
  expect(product.offers.priceCurrency).toBe("BDT");
  // The seed prices this at 1,850 taka.
  expect(product.offers.price).toBe("1850.00");
  expect(product.offers.availability).toBe("https://schema.org/PreOrder");
});

test("the structured data agrees with the price on the page", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  const product = blocks
    .map((block) => JSON.parse(block))
    .find((item) => item["@type"] === "Product");

  const rendered = await page.getByText("BDT 1,850").first().innerText();

  // A rich result that contradicts the page is worse than none at all.
  expect(rendered.replace(/[^0-9]/g, "")).toBe(
    String(Math.round(Number(product.offers.price))),
  );
});

test("the product page carries a breadcrumb trail", async ({ page }) => {
  await page.goto("/products/seasonal-candy-variety-box");

  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  const crumbs = blocks
    .map((block) => JSON.parse(block))
    .find((item) => item["@type"] === "BreadcrumbList");

  expect(crumbs).toBeDefined();
  expect(crumbs.itemListElement[0].name).toBe("Home");
  expect(crumbs.itemListElement.at(-1).name).toBe(
    "Seasonal Candy Variety Box",
  );
});

test("every page declares a canonical title and description", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  await expect(page).toHaveTitle(/Seasonal Candy Variety Box/);

  const description = await page
    .locator('meta[name="description"]')
    .getAttribute("content");
  expect(description).toBeTruthy();
  expect(description!.length).toBeGreaterThan(20);
});

test("the sitemap lists products and categories, and nothing private", async ({
  page,
}) => {
  const response = await page.goto("/sitemap.xml");
  expect(response?.status()).toBe(200);

  const xml = await page.content();

  expect(xml).toContain("/products/seasonal-candy-variety-box");
  expect(xml).toContain("/categories/electronics");

  // Private pages must never appear.
  for (const path of ["/admin", "/account", "/cart", "/checkout"]) {
    expect(xml).not.toContain(`<loc>${path}`);
  }
});

test("robots.txt keeps crawlers out of the private areas", async ({ page }) => {
  const response = await page.goto("/robots.txt");
  expect(response?.status()).toBe(200);

  const text = await response!.text();

  for (const path of ["/admin", "/account", "/cart", "/checkout", "/api"]) {
    expect(text).toContain(path);
  }
  expect(text).toContain("Sitemap:");
});

test("the cart and checkout are marked noindex", async ({ page }) => {
  await page.goto("/cart");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/,
  );
});

/**
 * The budget from docs/DESIGN_GUIDELINES.md: under 200KB of JavaScript,
 * gzipped.
 *
 * Measured on the product page, which the guideline names, and on the home
 * page, which is the heaviest on the site and the one a first-time visitor
 * lands on. The home page carries the carousel, its drag gesture and the
 * ticker; at the last measurement it sat at 181KB gzipped against the 200KB
 * ceiling, so it has the least room and is the one most worth watching.
 */
async function measureJavaScript(
  page: import("@playwright/test").Page,
  path: string,
) {
  let transferred = 0;

  const collect = async (response: import("@playwright/test").Response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!type.includes("javascript")) return;

    try {
      const body = await response.body();
      transferred += body.length;
    } catch {
      // A response that cannot be read (redirect, cached) contributes nothing.
    }
  };

  page.on("response", collect);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  page.off("response", collect);

  return transferred / 1024;
}

/**
 * Uncompressed ceilings, because the suite measures what came off the wire
 * before gzip. Gzip takes roughly a third, so these are set at three times the
 * 200KB gzipped guideline — enough to catch a dependency that balloons the
 * bundle without pretending to be the compressed figure.
 */
const PRODUCTION_CEILING_KB = 640;

/**
 * Against the dev server the figure is meaningless as a budget — modules are
 * unminified and uncompressed — so the ceiling is only wide enough to catch a
 * dependency that balloons the bundle. Run npm run test:e2e:prod for the real
 * measurement.
 */
const DEVELOPMENT_CEILING_KB = 4600;

function ceiling() {
  return process.env.E2E_PRODUCTION === "1"
    ? PRODUCTION_CEILING_KB
    : DEVELOPMENT_CEILING_KB;
}

test("the product page stays inside the JavaScript budget", async ({ page }) => {
  const kilobytes = await measureJavaScript(
    page,
    "/products/seasonal-candy-variety-box",
  );
  expect(kilobytes).toBeLessThan(ceiling());
});

test("the home page stays inside the JavaScript budget", async ({ page }) => {
  const kilobytes = await measureJavaScript(page, "/");
  expect(kilobytes).toBeLessThan(ceiling());
});

test("no layout shift from images without dimensions", async ({ page }) => {
  await page.goto("/products/seasonal-candy-variety-box");

  // Every image reserves its space, either with attributes or with an
  // aspect-ratio box, so the page does not jump as media arrives.
  const unsized = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img")).filter((image) => {
      const hasAttributes = image.hasAttribute("width") && image.hasAttribute("height");
      const parent = image.parentElement;
      const reserved =
        parent !== null &&
        getComputedStyle(parent).aspectRatio !== "auto";
      return !hasAttributes && !reserved;
    }).length,
  );

  expect(unsized).toBe(0);
});

test("the home page renders its heading without waiting on JavaScript", async ({
  browser,
}) => {
  // Server-rendered content must be present with scripting disabled: this is
  // what a crawler and a slow connection see.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto("/");
  // The heading is server-rendered but visually hidden — the photograph
  // carries nothing — so this asserts the markup rather than the pixels.
  await expect(
    page.getByRole("heading", { level: 1, includeHidden: true }),
  ).toHaveText(/Manifest/);
  await expect(
    page.getByRole("region", { name: "Promotions" }),
  ).toBeVisible();

  await context.close();
});
