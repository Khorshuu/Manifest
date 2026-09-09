import { expect, test } from "@playwright/test";

test("the storefront home page renders", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /American goods, landed in Bangladesh/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Manifest" }).first()).toBeVisible();
});

test("the page states the landed-price promise", async ({ page }) => {
  await page.goto("/");

  // The core promise of the business, and the thing shoppers most need to
  // trust: no surprise charge on delivery. Asserted twice because it is made
  // twice on purpose — once in the hero, where a first-time visitor lands, and
  // again at the foot of the page, where the objection actually surfaces.
  await expect(
    page.getByText(/shipping and customs duty already inside it/i),
  ).toBeVisible();
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
