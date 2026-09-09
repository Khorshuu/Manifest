import { expect, test, type Page } from "@playwright/test";

/**
 * The landed price in the browser.
 *
 * The promise is one fixed price with shipping and duty already inside it. The
 * breakdown exists so everyone can see what the price is made of — it must
 * never read as something added at the end.
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

async function placeGuestOrder(page: Page) {
  const email = `landed-${crypto.randomUUID().slice(0, 8)}@example.com`;

  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/products/seasonal-candy-variety-box");
  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  await added;

  await page.goto("/checkout");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Recipient name").fill("A Shopper");
  await page.getByLabel("Phone for delivery").fill("+8801700000000");
  await page.getByLabel("Address", { exact: true }).fill("12 Example Road");
  await page.getByLabel("City").fill("Dhaka");
  await page.getByLabel("District").fill("Dhaka");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  const text = await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText();
  return { orderNumber: text.match(/ORD-\d{4}-\d{6}/)![0], email };
}

test("checkout never adds shipping or duty on top of the price", async ({
  page,
}) => {
  test.slow();

  await page.goto("/products/seasonal-candy-variety-box");
  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  await added;

  await page.goto("/cart");
  const summary = page.getByRole("heading", { name: "Summary" }).locator("..");
  const cartSubtotal = await summary
    .getByText(/^BDT/)
    .first()
    .innerText();
  // The cart states it outright: nothing is added later.
  await expect(summary.getByText("Included")).toBeVisible();

  await page.goto("/checkout");
  const checkoutSummary = page
    .getByRole("heading", { name: "Order summary" })
    .locator("..");

  // The same figure carried through, and still nothing added.
  await expect(checkoutSummary.getByText(cartSubtotal).first()).toBeVisible();
  await expect(checkoutSummary.getByText("Included")).toBeVisible();
});

test("a shopper sees what the landed price is made of", async ({ page }) => {
  test.slow();

  const { orderNumber, email } = await placeGuestOrder(page);

  await page.goto(
    `/orders/lookup?order=${orderNumber}&email=${encodeURIComponent(email)}`,
  );

  // Exact, and scoped: the footer copy also mentions duty.
  await expect(page.getByText("Goods", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Shipping from the US", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Customs duty", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Shipping and duty are already inside this total."),
  ).toBeVisible();
});

test("staff see the same split on the order", async ({ page }) => {
  test.slow();

  const { orderNumber } = await placeGuestOrder(page);

  await signIn(page, "staff@example.com");
  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/orders/"));

  const totals = page.getByRole("heading", { name: "Totals" }).locator("..");
  await expect(totals.getByText("Goods")).toBeVisible();
  await expect(totals.getByText("Shipping")).toBeVisible();
  await expect(totals.getByText("Duty")).toBeVisible();
});

test("staff can read settings but only a super admin writes them", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/settings");

  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Customs duty percent")).toBeDisabled();

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "landed.duty_percent", value: 1 }),
    });
    return response.status;
  });

  expect(status).toBe(403);
});

test("a super admin changes a setting and it is audited", async ({ page }) => {
  test.slow();

  await signIn(page, "admin@example.com");
  await page.goto("/admin/settings");

  const value = 20 + Math.floor(Math.random() * 40);
  await page.getByLabel("Customs duty percent").fill(String(value));

  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/settings") &&
      r.request().method() === "PATCH",
  );
  await page
    .getByRole("listitem")
    .filter({ hasText: "Customs duty percent" })
    .getByRole("button", { name: "Save" })
    .click();
  expect((await saved).status()).toBe(200);

  await page.reload();
  await expect(page.getByLabel("Customs duty percent")).toHaveValue(
    String(value),
  );

  // The audit log records the change, with the value that replaced the old one.
  await page.goto("/admin/audit?action=site_settings.updated");
  await expect(page.getByText("site_settings.updated").first()).toBeVisible();
  await expect(page.getByText(`{"value":${value}}`).first()).toBeVisible();
});

test("a customer cannot read or write settings", async ({ page }) => {
  await signIn(page, "customer@example.com");

  await page.goto("/admin/settings");
  await expect(page).not.toHaveURL(/\/admin\/settings/);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "landed.duty_percent", value: 1 }),
    });
    return response.status;
  });

  expect(status).toBe(403);
});
