import { expect, test, type Page } from "@playwright/test";

/**
 * The analytics page in a browser.
 *
 * Two things worth asserting beyond the numbers: revenue stays behind the
 * super-admin gate, and the page states what it cannot measure rather than
 * quietly presenting a partial funnel as complete.
 */

async function signIn(page: Page, email: string) {
  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** The funnel's own card, so its labels are not confused with the KPI row's. */
function funnelCard(page: Page) {
  return page.getByRole("heading", { name: "Purchase funnel" }).locator("..");
}

test("the funnel is shown with a conversion between steps", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  const funnel = funnelCard(page);
  await expect(funnel.getByText("Carts started")).toBeVisible();
  await expect(funnel.getByText("Orders placed")).toBeVisible();
  // Each step after the first carries its conversion from the one above.
  await expect(funnel.getByText(/· \d+%/).first()).toBeVisible();
});

/** Honesty about the gap is part of the report. */
test("the page names what it cannot measure", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(funnelCard(page).getByText(/Not recorded yet:.*Product views/)).toBeVisible();
});

test("a super admin sees sales", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByText("Sales", { exact: true })).toBeVisible();
  await expect(page.getByText("Average order", { exact: true })).toBeVisible();
});

test("a staff admin sees the funnel but no money", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Purchase funnel" })).toBeVisible();
  await expect(page.getByText("Sales", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Average order", { exact: true })).toHaveCount(0);
});

test("the reporting period can be changed", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await page.getByRole("link", { name: "7 days", exact: true }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(
    page.getByRole("link", { name: "7 days", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});

test("preorder commitment is reported", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/analytics");

  const card = page.getByRole("heading", { name: "Preorder performance" }).locator("..");
  await expect(card).toBeVisible();
  await expect(card.getByText("Places offered")).toBeVisible();
  await expect(card.getByText("Utilisation")).toBeVisible();
});

test("a customer cannot reach analytics", async ({ page }) => {
  await signIn(page, "customer@example.com");
  await page.goto("/admin/analytics");
  await expect(page).toHaveURL("/");
});
