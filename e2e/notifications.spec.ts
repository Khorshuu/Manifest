import { expect, test, type Page } from "@playwright/test";
import { addToCart, fillGuestCheckout } from "./helpers/cart";

/**
 * The notification outbox in the browser: a real order writes a real row, staff
 * can drain it, and a customer can never see it.
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

test("the outbox says plainly that nothing is actually delivered", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  // The notice sits with the customer messages it qualifies, not the inbox.
  await page.goto("/admin/notifications?tab=messages");

  await expect(
    page.getByRole("heading", { name: "Notifications", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText(/No email or SMS provider is connected\./),
  ).toBeVisible();
});

test("placing an order writes a message staff can see and send", async ({
  page,
}) => {
  // A whole checkout plus a sign-in, waiting on a background delivery.
  test.slow();

  // A guest checkout, so the address on the row is one this test controls.
  const email = `outbox-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await addToCart(page);

  await page.goto("/checkout");

  await fillGuestCheckout(page, { email: email, name: "Outbox Tester" });

  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  const orderNumber = (await page
    .getByText(/ORD-\d{4}-\d{6}/)
    .first()
    .textContent())!.match(/ORD-\d{4}-\d{6}/)![0];

  await signIn(page, "staff@example.com");
  // Customer messages have their own tab; the default view is the staff
  // inbox, which also names the order ("New order …") but has no status.
  await page.goto("/admin/notifications?tab=messages");

  // A card on a phone, a table row from md up; whichever this viewport shows.
  const row = page
    .getByRole("main")
    .locator("li, tr")
    .filter({ hasText: orderNumber, visible: true });
  await expect(row).toBeVisible();
  await expect(row).toContainText(email);

  // Placement drains the outbox itself, so the row reaches "sent" without
  // anyone pressing anything.
  await expect(async () => {
    await page.reload();
    await expect(row.first()).toContainText("sent");
  }).toPass({ timeout: 45_000 });

  // Deliberately not asserting the drain button is disabled: whether anything
  // is queued is global state, and other tests place orders in parallel.
  await expect(
    page.getByRole("button", { name: "Send queued messages" }),
  ).toBeVisible();
});

test("staff can drain the outbox on demand", async ({ page }) => {
  await signIn(page, "staff@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/notifications", { method: "POST" });
    return { status: response.status, body: await response.json() };
  });

  expect(result.status).toBe(200);
  // A real report of what was attempted, not a fixed success message.
  expect(result.body.report).toMatchObject({
    attempted: expect.any(Number),
    sent: expect.any(Number),
    failed: expect.any(Number),
  });
});

test("a customer cannot reach the outbox", async ({ page }) => {
  await signIn(page, "customer@example.com");

  await page.goto("/admin/notifications");
  // The admin layout sends a customer away; the API refuses them outright.
  await expect(page).not.toHaveURL(/\/admin\/notifications/);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/notifications", { method: "POST" });
    return response.status;
  });

  expect(status).toBe(403);
});

test("an anonymous visitor cannot drain the outbox", async ({ page }) => {
  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/notifications", { method: "POST" });
    return response.status;
  });

  expect(status).toBe(401);
});
