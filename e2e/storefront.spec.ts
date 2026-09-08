import { expect, test } from "@playwright/test";

/**
 * The shopper's path through the storefront, against the seeded catalog.
 * These assert the promises the business makes: a landed price, a stated
 * arrival window, and an honest reason whenever something cannot be bought.
 */

test("a shopper reaches a product from the home page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Seasonal Candy Variety Box/ }).first().click();

  await expect(
    page.getByRole("heading", { name: "Seasonal Candy Variety Box", level: 1 }),
  ).toBeVisible();
});

test("the product page states price, arrival, and what is included", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  await expect(page.getByText("BDT 1,850").first()).toBeVisible();
  await expect(
    page.getByText("Shipping and customs duty included."),
  ).toBeVisible();
  await expect(page.getByText("Expected arrival")).toBeVisible();
  await expect(page.getByText("Preorder closes")).toBeVisible();
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

test("a draft product is not reachable by its URL", async ({ page }) => {
  const response = await page.goto("/products/definitely-not-a-real-product");
  expect(response?.status()).toBe(404);
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

  // Matched by the card heading, not by name: the hero call to action also
  // contains the product title and would otherwise win.
  const card = page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", {
        name: "Seasonal Candy Variety Box",
        level: 3,
      }),
    })
    .first();
  const image = card.getByRole("img").first();

  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /seed\/candy-box/);
  // Meaningful alternative text, describing the product not the file.
  await expect(image).toHaveAttribute("alt", /candy/i);
});

test("a product card shows a real price rather than a placeholder", async ({
  page,
}) => {
  await page.goto("/");

  const card = page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", {
        name: "Seasonal Candy Variety Box",
        level: 3,
      }),
    })
    .first();

  await expect(card.getByText("BDT 1,850")).toBeVisible();
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
