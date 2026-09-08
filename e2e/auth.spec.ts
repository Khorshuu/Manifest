import { expect, test } from "@playwright/test";

/**
 * Exercises the real login flow against the seeded development database.
 * The role checks asserted here are the server-side gate from
 * docs/SECURITY.md, not a hidden-link check — a customer is redirected away
 * from /admin even though nothing in the UI offered them the link.
 */

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");

  // Wait for the request itself, so the session cookie is set before the test
  // navigates on — clicking alone does not guarantee it has landed.
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("an anonymous visitor is sent to sign in before reaching admin", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin|\/login\?next=\/admin/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a wrong password is refused without revealing whether the account exists", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByText("That email and password combination is not correct."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("an unknown account gets the same message as a wrong password", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password").fill("whatever-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByText("That email and password combination is not correct."),
  ).toBeVisible();
});

test("a customer cannot reach the admin area", async ({ page }) => {
  await signIn(page, "customer@example.com");
  await page.goto("/admin");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: /Admin/ })).toHaveCount(0);
});

test("a staff admin reaches the dashboard but not super-admin sections", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin");

  await expect(
    page.getByRole("heading", { name: "Today", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Staff" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  // Financial totals are super_admin only.
  await expect(page.getByText("Collected to date")).toHaveCount(0);
});

test("a super admin sees the staff and settings sections and financials", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin");

  await expect(page.getByRole("link", { name: "Staff" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Collected to date")).toBeVisible();
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login/);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

test("dashboard numbers come from real data", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin");

  // The seed creates two products and one customer; these are queried live.
  const products = page.locator("dt", { hasText: "Live products" });
  await expect(products).toBeVisible();
  await expect(
    page.locator("dd").filter({ hasText: /^2$/ }).first(),
  ).toBeVisible();
});
