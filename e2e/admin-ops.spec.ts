import { expect, test, type Page } from "@playwright/test";

/**
 * Admin operations in the browser.
 *
 * The assertions that matter are the gated ones: a staff admin sees the
 * dashboard but not money, not the staff page, and not the margin export.
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

test("the dashboard reports live figures, not placeholders", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  // The seed creates two products and one customer; both come from a query.
  const products = page.locator("div", {
    has: page.getByText("Live products", { exact: true }),
  });
  await expect(products.last().locator("dd")).toHaveText(/^\d+$/);

  await expect(page.getByText("Collected to date")).toBeVisible();
});

test("a staff admin sees the dashboard but no money", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("Collected to date")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Margin (CSV)" })).toHaveCount(0);
});

test("a staff admin is redirected away from the staff page", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/staff");
  await expect(page).toHaveURL(/\/admin$/);
});

test("a super admin manages staff roles", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/staff");

  await expect(
    page.getByRole("heading", { name: "Staff", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByText("admin@example.com").first(),
  ).toBeVisible();

  // Changing your own role is refused, and the UI says so rather than
  // offering a button that would fail.
  await expect(page.getByText("Ask another super admin")).toBeVisible();
});

test("a super admin creates a staff account", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/staff");

  const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const form = page.locator("form");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Temporary password").fill("a-long-enough-password");

  const created = page.waitForResponse(
    (r) => r.url().includes("/api/admin/staff") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create account" }).click();
  expect((await created).status()).toBe(200);

  await expect(page.getByText("Account created.")).toBeVisible();
  await expect(page.getByText(email).first()).toBeVisible({ timeout: 15_000 });
});

test("the audit log shows who made each change", async ({ page }) => {
  await signIn(page, "admin@example.com");

  // Make a change worth recording.
  await page.goto("/admin/products/new");
  const title = `Audited ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL((url) => url.pathname.includes("/wizard"));

  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByText("product.created").first()).toBeVisible();
  await expect(
    page.getByRole("main").getByText("admin@example.com").first(),
  ).toBeVisible();
});

test("the audit log filters by action", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/audit?action=product.created");

  await expect(
    page.getByRole("link", { name: "product.created" }),
  ).toHaveAttribute("aria-current", "page");
});

test("the orders export downloads a CSV", async ({ page }) => {
  await signIn(page, "staff@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/export?report=orders");
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
    };
  });

  expect(result.status).toBe(200);
  expect(result.type).toContain("text/csv");
  expect(result.body.split("\r\n")[0]).toContain("Order number");
});

/** The sourcing cost is super-admin only (docs/SECURITY.md). */
test("a staff admin is refused the margin export", async ({ page }) => {
  await signIn(page, "staff@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/export?report=margin");
    return { status: response.status };
  });

  expect(result.status).toBe(403);
});

test("a super admin gets the margin export with the cost column", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/export?report=margin");
    return { status: response.status, body: await response.text() };
  });

  expect(result.status).toBe(200);
  expect(result.body).toContain("Cost (USD)");
});

test("a customer cannot download any export", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/export?report=orders");
    return { status: response.status };
  });

  expect(result.status).toBe(403);
});

test("a customer cannot create a staff account through the API", async ({
  page,
}) => {
  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sneaky@example.com",
        password: "a-long-enough-password",
        role: "super_admin",
      }),
    });
    return { status: response.status };
  });

  expect(result.status).toBe(403);
});
