import { expect, test, type Page } from "@playwright/test";

/**
 * The analytics page in a browser.
 *
 * Two things worth asserting beyond the numbers: revenue stays behind the
 * super-admin gate, and the page states what it cannot measure rather than
 * quietly presenting a partial funnel as complete.
 */

async function signIn(page: Page, email: string) {
  await page.goto("/");
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

test("the funnel is shown with a conversion between steps", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Funnel" })).toBeVisible();
  await expect(page.getByText("Carts started")).toBeVisible();
  await expect(page.getByText("Orders placed")).toBeVisible();
  await expect(page.getByText(/of the step above/).first()).toBeVisible();
});

/** Honesty about the gap is part of the report. */
test("the page names what it cannot measure", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByText("Not measured yet")).toBeVisible();
  await expect(page.getByText(/product views/i)).toBeVisible();
});

test("a super admin sees revenue", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Revenue" })).toBeVisible();
  // Either a total or the empty state, both of which say "collected". Scoped
  // to the first match: other sections render while the page is under load.
  await expect(page.getByText(/collected/).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("a staff admin sees the funnel but no revenue", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Funnel" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revenue" })).toHaveCount(0);
});

test("the reporting period can be changed", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/analytics");

  await page.getByRole("link", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(
    page.getByRole("link", { name: "Last 7 days" }),
  ).toHaveAttribute("aria-current", "page");
});

test("preorder commitment is reported", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/analytics");

  await expect(
    page.getByRole("heading", { name: "Preorder commitment" }),
  ).toBeVisible();
  await expect(page.getByText("Capacity offered")).toBeVisible();
  await expect(page.getByText("Utilisation")).toBeVisible();
});

test("a customer cannot reach analytics", async ({ page }) => {
  await signIn(page, "customer@example.com");
  await page.goto("/admin/analytics");
  await expect(page).toHaveURL("/");
});
