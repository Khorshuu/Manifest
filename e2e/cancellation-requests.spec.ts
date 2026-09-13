import { expect, test, type Page } from "@playwright/test";

/**
 * The cancellation review queue.
 *
 * A shopper asking to cancel records a request; staff decide (DECISIONS.md
 * D-014). These assert the part that matters most and is easiest to get
 * wrong — that asking does not cancel anything, and that only staff can answer.
 */

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/**
 * A fresh shopper with one order, placed through the API.
 *
 * The checkout form has its own suite; walking it again here would only make
 * this file slow.
 */
async function orderAsNewShopper(page: Page) {
  const email = `cancel-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.evaluate(async (address: string) => {
    await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Shopper", email: address, password: "password123" }),
    });
  }, email);

  // The seeded candy box is deliberately roomy, so parallel tests do not
  // exhaust it.
  await page.goto("/products/seasonal-candy-variety-box");
  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  await added;

  const placed = await page.evaluate(async (address: string) => {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: address,
        method: "bkash",
        idempotencyKey: crypto.randomUUID(),
        address: {
          recipientName: "A Shopper",
          phone: "+8801700000000",
          addressLine1: "12 Example Road",
          city: "Dhaka",
          district: "Dhaka",
        },
      }),
    });
    return { status: response.status, body: await response.text() };
  }, email);

  expect(placed.status, `checkout refused: ${placed.body}`).toBeLessThan(300);

  const order = JSON.parse(placed.body).order;
  return { email, orderNumber: order.orderNumber as string, orderId: order.orderId as string };
}

async function askToCancel(page: Page, orderId: string, reason: string) {
  return page.evaluate(
    async ([id, why]) => {
      const response = await fetch(`/api/orders/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: why }),
      });
      return { status: response.status, body: await response.json() };
    },
    [orderId, reason] as const,
  );
}

test("asking to cancel does not cancel the order", async ({ page }) => {
  test.slow();

  const { orderId, orderNumber } = await orderAsNewShopper(page);

  const result = await askToCancel(page, orderId, "Ordered by mistake");
  expect(result.status).toBe(200);
  expect(result.body.result.alreadyRequested).toBe(false);

  // Still running, from the shopper's own page.
  await page.goto(`/account/orders/${orderId}`);
  await expect(page.getByText(/You asked us to cancel this order/)).toBeVisible();
  await expect(
    page.getByText("This order is no longer in progress."),
  ).toHaveCount(0);

  // And waiting in the staff queue, in the shopper's words.
  await signIn(page, "staff@example.com");
  await page.goto("/admin/orders?status=cancellation_requested");

  // Scoped to this order's own row: the suite runs in parallel against one
  // database, so other tests have their own requests in this same queue.
  const row = page
    .getByRole("listitem")
    .filter({ hasText: orderNumber })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Ordered by mistake")).toBeVisible();
});

test("staff decline, and the order carries on", async ({ page }) => {
  test.slow();

  const { orderId, orderNumber } = await orderAsNewShopper(page);
  await askToCancel(page, orderId, "Not sure any more");

  await signIn(page, "staff@example.com");
  await page.goto(`/admin/orders/${orderId}`);

  const resolved = page.waitForResponse(
    (r) => r.url().includes("/api/orders/") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Decline, keep the order" }).click();
  expect((await resolved).status()).toBe(200);

  // Gone from the queue, and the order is untouched.
  await page.goto("/admin/orders?status=cancellation_requested");
  await expect(page.getByRole("link", { name: orderNumber })).toHaveCount(0);

  // The order is untouched: no decision panel left, and nothing cancelled it.
  await page.goto(`/admin/orders/${orderId}`);
  await expect(
    page.getByText("This shopper has asked to cancel"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mark payment confirmed" }),
  ).toBeVisible();
});

test("a customer cannot answer their own request", async ({ page }) => {
  test.slow();

  const { orderId } = await orderAsNewShopper(page);
  await askToCancel(page, orderId, "Please cancel");

  // Still signed in as the shopper who owns the order.
  const status = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve_cancellation",
        decision: "approve",
      }),
    });
    return response.status;
  }, orderId);

  expect(status).toBe(403);
});

test("asking twice is not an error", async ({ page }) => {
  test.slow();

  const { orderId } = await orderAsNewShopper(page);

  const first = await askToCancel(page, orderId, "One");
  const second = await askToCancel(page, orderId, "Two");

  expect(first.body.result.alreadyRequested).toBe(false);
  expect(second.body.result.alreadyRequested).toBe(true);
});
