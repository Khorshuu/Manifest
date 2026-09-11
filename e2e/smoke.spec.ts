import { expect, test } from "@playwright/test";

test("the storefront home page renders", async ({ page }) => {
  await page.goto("/");

  /*
   * The page's h1 is deliberately not drawn on the photograph any more — the
   * owner asked for the image to carry nothing — so it is asserted as markup a
   * crawler and a screen reader receive, not as pixels.
   */
  await expect(
    page.getByRole("heading", { level: 1, includeHidden: true }),
  ).toHaveText(/Manifest/);
  await expect(page.getByRole("link", { name: "Manifest" }).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Promotions" }),
  ).toBeVisible();
});

test("the page states the landed-price promise", async ({ page }) => {
  await page.goto("/");

  // The core promise of the business, and the thing shoppers most need to
  // trust: no surprise charge on delivery. Asserted twice because it is made
  // twice on purpose — once under the product row, which is the first thing
  // below the photograph, and again at the foot of the page where the
  // objection actually surfaces.
  await expect(
    page.getByText(/Duty and freight inside the price/i).first(),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "One landed price" }),
  ).toBeVisible();
});

test("the body does not scroll sideways on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
});
