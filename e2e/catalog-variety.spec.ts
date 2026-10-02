import { expect, test, type Page } from "@playwright/test";
import { addToCart } from "./helpers/cart";
import { VARIETY } from "./seed-variety";

/**
 * The listings the development seed does not have (e2e/seed-variety.ts): sold
 * from stock, out of stock, low stock on sale, a very long title on a deposit,
 * a listing with nothing optional, and a draft. They live on one shelf of
 * their own, so the counts here are exact and no other spec's counts move.
 */

const SHELF = `/categories/${VARIETY.shelf.slug}`;
const PUBLIC = [VARIETY.inStock, VARIETY.outOfStock, VARIETY.lowStock, VARIETY.longTitle, VARIETY.sparse];

function card(page: Page, title: string) {
  return page.getByRole("link").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
}

async function overflowsSideways(page: Page) {
  await page.waitForLoadState("networkidle");
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test("the shelf lists every public listing and never the draft", async ({ page }) => {
  await page.goto(SHELF);

  await expect(page.getByRole("heading", { name: VARIETY.shelf.name, level: 1 })).toBeVisible();
  for (const entry of PUBLIC) await expect(card(page, entry.title)).toHaveCount(1);
  await expect(page.getByText(VARIETY.draft.title)).toHaveCount(0);
  // The panel's own count, which has to agree with the grid.
  await expect(page.locator("[data-result-count]").first()).toHaveAttribute("data-result-count", String(PUBLIC.length));
});

test("each card says what is true of its listing", async ({ page }) => {
  await page.goto(SHELF);

  await expect(card(page, VARIETY.inStock.title)).toContainText("In stock");
  await expect(card(page, VARIETY.outOfStock.title)).toContainText("Out of stock");
  await expect(card(page, VARIETY.longTitle.title)).toContainText("Preorder open");

  // On sale: the price charged, the price it replaces, and the saving.
  const sale = card(page, VARIETY.lowStock.title);
  await expect(sale).toContainText("BDT 1,150");
  await expect(sale).toContainText("Regular price BDT 1,400");
  await expect(sale).toContainText("18% off");
  // No saving is claimed where no sale runs.
  await expect(card(page, VARIETY.inStock.title)).not.toContainText("% off");
});

test("a listing sold from stock goes into the cart as stock, with no preorder window", async ({ page }) => {
  await addToCart(page, `/products/${VARIETY.inStock.slug}`);

  await expect(page.getByRole("timer", { name: /Preorder closes in/ })).toHaveCount(0);

  await page.goto("/cart");
  const main = page.getByRole("main");
  await expect(main.getByText(VARIETY.inStock.title).first()).toBeVisible();
  await expect(main.getByText("In stock").filter({ visible: true }).first()).toBeVisible();
  await expect(main.getByText("BDT 950").filter({ visible: true }).first()).toBeVisible();
});

test("an out-of-stock listing cannot be bought and says why", async ({ page }) => {
  await page.goto(`/products/${VARIETY.outOfStock.slug}`);

  await expect(page.getByRole("heading", { name: VARIETY.outOfStock.title, level: 1 })).toBeVisible();
  await expect(page.getByText("Out of stock").filter({ visible: true }).first()).toBeVisible();

  const unavailable = page.getByRole("button", { name: "Unavailable" }).filter({ visible: true });
  await expect(unavailable.first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /^(Add to cart|Add)$/ }).filter({ visible: true })).toHaveCount(0);
  // Sold from stock, so the reason is about stock, not about a preorder.
  await expect(page.getByText(/This item is out of stock\./)).toBeVisible();
  await expect(page.getByText(/This preorder is full/)).toHaveCount(0);
});

test("a low-stock listing on sale shows the sale price, the regular price and the saving", async ({ page }) => {
  await page.goto(`/products/${VARIETY.lowStock.slug}`);

  await expect(page.getByText("Low stock").filter({ visible: true }).first()).toBeVisible();
  // Stock, counted as stock: no "places" in a batch.
  await expect(page.getByText("2 left in stock").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("BDT 1,150").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Save 18%").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Regular price BDT 1,400").first()).toBeAttached();
});

test("a very long title is shown whole and does not widen the page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });

  await page.goto(`/products/${VARIETY.longTitle.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(VARIETY.longTitle.title);
  expect(await overflowsSideways(page)).toBe(false);

  await page.goto(SHELF);
  await expect(card(page, VARIETY.longTitle.title)).toHaveCount(1);
  expect(await overflowsSideways(page)).toBe(false);
});

test("a deposit listing states what is due now", async ({ page }) => {
  await page.goto(`/products/${VARIETY.longTitle.slug}`);

  // 30% of BDT 2,600.
  await expect(page.getByText("BDT 780 (30% deposit)").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Expected arrival")).toBeVisible();
});

test("a listing with nothing optional renders without empty sections", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`/products/${VARIETY.sparse.slug}`);

  await expect(page.getByRole("heading", { name: VARIETY.sparse.title, level: 1 })).toBeVisible();
  await expect(page.getByText("A plain desk blotter.").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("BDT 700").filter({ visible: true }).first()).toBeVisible();
  // Nothing optional was entered, so none of its sections is drawn.
  for (const name of ["Key features", "What's in the box", "Warranty", "Certifications and safety"]) {
    await expect(page.getByRole("heading", { name })).toHaveCount(0);
  }
  await expect(page.getByRole("tab", { name: "Specification" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a draft is not reachable by address, search or suggestion", async ({ page }) => {
  // The status is 200 because the shell streams first (see storefront.spec.ts);
  // what holds is that the page is the not-found one and offers nothing to buy.
  await page.goto(`/products/${VARIETY.draft.slug}`);
  await expect(page.getByRole("heading", { name: "We could not find that page" })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  await expect(page.getByText(VARIETY.draft.title)).toHaveCount(0);
  await expect(page.getByText(/BDT/)).toHaveCount(0);

  await page.goto(`/search?q=${encodeURIComponent("weekly planner")}`);
  await expect(page.getByText(VARIETY.draft.title)).toHaveCount(0);

  const body = await page.evaluate(async () => (await fetch("/api/search/suggest?q=unreleased")).json());
  expect(JSON.stringify(body)).not.toContain("Unreleased");
});

test("search finds a variety listing by a word in its title", async ({ page }) => {
  await page.goto(`/search?q=${encodeURIComponent("fountain pen")}`);

  await expect(card(page, VARIETY.outOfStock.title)).toHaveCount(1);
});

test("the in-stock filter leaves out preorders", async ({ page }) => {
  await page.goto(`${SHELF}?fulfillment=in_stock`);

  await expect(card(page, VARIETY.inStock.title)).toHaveCount(1);
  await expect(card(page, VARIETY.longTitle.title)).toHaveCount(0);
});
