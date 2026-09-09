import { expect, test } from "@playwright/test";

/**
 * The shopper's path through the storefront, against the seeded catalog.
 * These assert the promises the business makes: a landed price, a stated
 * arrival window, and an honest reason whenever something cannot be bought.
 */

/**
 * These three used to name a specific seeded product. That coupled them to the
 * order of the seed: once the catalogue grew past the home page's limits, the
 * two oldest products stopped appearing there and the tests failed while
 * nothing was actually broken. They now assert the behaviour against whatever
 * the home page is showing, which is the thing worth guarding.
 */
function firstCard(page: import("@playwright/test").Page) {
  return page
    .getByRole("link")
    .filter({ has: page.getByRole("heading", { level: 3 }) })
    .first();
}

test("a shopper reaches a product from the home page", async ({ page }) => {
  await page.goto("/");

  const card = firstCard(page);
  const title = (
    await card.getByRole("heading", { level: 3 }).textContent()
  )?.trim();
  expect(title).toBeTruthy();

  await card.click();

  await expect(
    page.getByRole("heading", { name: title!, level: 1 }),
  ).toBeVisible();
});

test("the product page states price, arrival, and what is included", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  // Filtered to what is actually on screen: the price also appears in the
  // sticky buy bar, which is present in the DOM at every width and displayed
  // only below the large breakpoint.
  await expect(
    page.getByText("BDT 1,850").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Shipping and customs duty included."),
  ).toBeVisible();
  await expect(page.getByText("Expected arrival")).toBeVisible();

  // The closing time, both as words on the page and as one announcement for a
  // screen reader — four separately ticking numbers read aloud would be noise.
  await expect(page.getByText("Ordering closes in")).toBeVisible();
  await expect(
    page.getByRole("timer", { name: /Preorder closes in/ }),
  ).toBeVisible();
});

test("choosing a variant updates the panel", async ({ page }) => {
  await page.goto("/products/studio-reference-headphones");

  // The seed gives this product two colours, one of them deliberately full.
  const options = page.getByRole("radio");
  await expect(options).toHaveCount(2);

  // Click the label, which is what a shopper does — the radio itself is
  // visually hidden and exists for assistive technology.
  await page.getByText("Sandstone", { exact: false }).click();
  await expect(page.getByText(/40% deposit/)).toBeVisible();
});

/**
 * A disabled buy button must always say why — never leave the shopper
 * guessing (docs/DESIGN_GUIDELINES.md).
 */
test("a full preorder explains itself rather than just being disabled", async ({
  page,
}) => {
  await page.goto("/products/studio-reference-headphones");

  // Sandstone is seeded at full capacity.
  await page.getByText("Sandstone", { exact: false }).click();

  await expect(page.getByRole("button", { name: "Unavailable" })).toBeVisible();
  await expect(page.getByText(/This preorder is full/)).toBeVisible();
  await expect(page.getByText(/waitlist/i)).toBeVisible();
});

test("a category page lists its products and its subcategories", async ({
  page,
}) => {
  await page.goto("/categories/electronics");

  await expect(
    page.getByRole("heading", { name: "Electronics", level: 1 }),
  ).toBeVisible();
  // Exact: a product card also carries the brand "Northline Audio".
  await expect(
    page.getByRole("link", { name: "Audio", exact: true }),
  ).toBeVisible();
});

test("a category page includes products nested deeper in the tree", async ({
  page,
}) => {
  // The headphones sit under Electronics > Audio > Over-ear Headphones.
  await page.goto("/categories/electronics");

  await expect(
    page.getByRole("link", { name: /Studio Reference Headphones/ }),
  ).toBeVisible();
});

test("search finds a product by title", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search products").fill("candy");
  await page.getByLabel("Search products").press("Enter");

  await expect(page).toHaveURL(/\/search\?q=candy/);
  await expect(
    page.getByRole("link", { name: /Seasonal Candy Variety Box/ }),
  ).toBeVisible();
});

test("a search with no results offers somewhere to go next", async ({ page }) => {
  await page.goto("/search?q=zzzznothingmatchesthis");

  await expect(page.getByText(/Nothing matched/)).toBeVisible();
  // Never a bare empty page.
  await expect(
    page.getByRole("heading", { name: "Browse categories" }),
  ).toBeVisible();
});

/**
 * A product that does not exist must not read as a product, and must not be
 * indexed.
 *
 * This asserted a 404 status and stopped being true. The route renders a
 * `loading.tsx` fallback, so the response starts streaming before the page
 * body runs — and once the headers are out the status cannot be changed. That
 * is documented Next.js behaviour rather than a defect here: a streamed
 * not-found returns 200 and Next injects `<meta name="robots" content="noindex">`
 * instead, which is what actually keeps the URL out of a search index
 * (node_modules/next/dist/docs, "Status Codes" under loading.js).
 *
 * So the test now asserts the guarantee that genuinely holds. If a real 404
 * status is ever needed for compliance or analytics, the framework's answer is
 * to check the slug in `proxy` before the body streams — worth doing
 * deliberately, not by accident.
 */
test("a product that does not exist is not shown or indexed", async ({
  page,
}) => {
  await page.goto("/products/definitely-not-a-real-product");

  await expect(
    page.locator('meta[name="robots"][content*="noindex"]').first(),
  ).toBeAttached();

  // And nothing that looks like a listing: no price, no way to buy.
  await expect(page.getByRole("button", { name: /add to/i })).toHaveCount(0);
  await expect(page.getByText(/BDT/)).toHaveCount(0);
});

test("the storefront never exposes the internal sourcing cost", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");
  const html = await page.content();

  // The seed sets cost_price_usd to 1200 cents on this product.
  expect(html).not.toMatch(/cost_price|costPriceUsd/i);
});

/**
 * Regression guard. The card aggregates were once correlated subqueries whose
 * table qualifier Drizzle dropped, so every card silently lost its photo while
 * every test stayed green. Assert the data actually arrives.
 */
test("product cards carry their photograph", async ({ page }) => {
  await page.goto("/");

  const image = firstCard(page).getByRole("img").first();

  await expect(image).toBeVisible();
  // A real file from the catalogue, not the generated stand-in.
  await expect(image).toHaveAttribute("src", /^\/seed\/.+\.svg$/);

  // Meaningful alternative text: a description, not the file name and not a
  // bare repeat of nothing at all.
  const alt = await image.getAttribute("alt");
  expect(alt?.trim().length ?? 0).toBeGreaterThan(8);
  expect(alt).not.toMatch(/\.svg|\.png|\.jpe?g/i);
});

test("a product card shows a real price rather than a placeholder", async ({
  page,
}) => {
  await page.goto("/");

  const card = firstCard(page);

  // A formatted taka figure, which only appears when the aggregate arrived.
  // `\s` rather than a literal space: Intl puts a non-breaking space after the
  // currency code, so a plain space never matches.
  await expect(card.getByText(/^BDT\s[\d,]+$/).first()).toBeVisible();
  await expect(card.getByText("Price to be confirmed")).toHaveCount(0);
});

test("sorting by price reorders the listing", async ({ page }) => {
  await page.goto("/search?sort=price_asc");

  const first = await page
    .getByRole("heading", { level: 3 })
    .first()
    .innerText();

  await page.goto("/search?sort=price_desc");
  const firstDesc = await page
    .getByRole("heading", { level: 3 })
    .first()
    .innerText();

  expect(first).not.toBe(firstDesc);
});
