import { expect, test, type Page } from "@playwright/test";

/**
 * Shipping as staff drive it, and what the shopper then sees.
 *
 * The rule with teeth here: internal notes are staff-only and must never
 * appear on a customer-facing page (docs/SECURITY.md).
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

/** Places a guest order and returns its number and email. */
async function placeGuestOrder(page: Page) {
  const email = `ship-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto("/");
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

async function openInAdmin(page: Page, orderNumber: string) {
  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/orders/"));
}

test("staff record a tracking reference and the shopper sees it", async ({
  page,
}) => {
  // A whole guest checkout before the assertion, alongside the whole suite.
  test.slow();

  const { orderNumber, email } = await placeGuestOrder(page);

  await signIn(page, "staff@example.com");
  await openInAdmin(page, orderNumber);

  const reference = `SA-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  await page.getByLabel("Tracking reference").fill(reference);

  const saved = page.waitForResponse(
    (r) => r.url().includes("/shipping") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save reference" }).click();
  expect((await saved).status()).toBe(200);

  // The shopper looks it up as a guest, with no session at all.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(`/orders/lookup?order=${orderNumber}&email=${email}`);

  await expect(page.getByText(reference)).toBeVisible();
});

test("booking a delivery produces a reference", async ({ page }) => {
  // A whole guest checkout before the assertion, alongside the whole suite.
  test.slow();

  const { orderNumber } = await placeGuestOrder(page);

  await signIn(page, "staff@example.com");
  await openInAdmin(page, orderNumber);

  const booked = page.waitForResponse(
    (r) => r.url().includes("/shipping") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Book with the courier" }).click();
  expect((await booked).status()).toBe(200);

  // The field is repopulated by the refreshed server render, so wait for the
  // value rather than asserting the instant the request returns.
  await expect(page.getByLabel("Tracking reference")).toHaveValue(/^MOCK-/, {
    timeout: 15_000,
  });
});

/**
 * The rule from docs/SECURITY.md: internal notes never reach a customer.
 */
test("an internal note is never shown to the customer", async ({ page }) => {
  // A whole guest checkout before the assertion, alongside the whole suite.
  test.slow();

  const { orderNumber, email } = await placeGuestOrder(page);
  const secret = `internal-${crypto.randomUUID().slice(0, 8)}`;

  await signIn(page, "staff@example.com");
  await openInAdmin(page, orderNumber);

  await page.getByLabel("Internal note").fill(secret);
  const noted = page.waitForResponse(
    (r) => r.url().includes("/shipping") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add note" }).click();
  expect((await noted).status()).toBe(200);

  // Staff can see it, once the refreshed render arrives.
  await expect(page.getByText(secret)).toBeVisible({ timeout: 15_000 });

  // The customer cannot — checked against the whole rendered page, not a
  // particular element, so a stray serialisation would still be caught.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(`/orders/lookup?order=${orderNumber}&email=${email}`);

  const html = await page.content();
  expect(html).not.toContain(secret);
});

test("a customer cannot set a tracking reference through the API", async ({
  page,
}) => {
  // A whole guest checkout before the assertion, alongside the whole suite.
  test.slow();

  const { orderNumber } = await placeGuestOrder(page);

  await signIn(page, "staff@example.com");
  await openInAdmin(page, orderNumber);
  const orderId = page.url().split("/").pop()!;

  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}/shipping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_tracking",
        trackingReference: "FAKE-1",
      }),
    });
    return { status: response.status };
  }, orderId);

  expect(result.status).toBe(403);
});

test("a customer cannot add an internal note through the API", async ({
  page,
}) => {
  // A whole guest checkout before the assertion, alongside the whole suite.
  test.slow();

  const { orderNumber } = await placeGuestOrder(page);

  await signIn(page, "staff@example.com");
  await openInAdmin(page, orderNumber);
  const orderId = page.url().split("/").pop()!;

  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}/shipping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "note", note: "let me in" }),
    });
    return { status: response.status };
  }, orderId);

  expect(result.status).toBe(403);
});
