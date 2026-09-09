import { expect, test, type Page } from "@playwright/test";

/**
 * The order lifecycle as staff and shoppers actually drive it: a shopper sees
 * their own orders and nobody else's, and staff move an order through the
 * pipeline without ever being able to move it backward.
 */

async function signIn(page: Page, email: string) {
  // Sign out first: the login page redirects away when a session already
  // exists, so switching accounts mid-test would otherwise hang. The logout
  // is a fetch, so this only needs an origin — and the home page, which it
  // used to load, is the heaviest route in the application.
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

/**
 * Registers a fresh customer.
 *
 * Tests run in parallel against one database, and a signed-in account has a
 * single cart, so sharing the seeded customer would mean one test emptying the
 * cart another had just filled.
 */
async function registerCustomer(page: Page): Promise<string> {
  const email = `shopper-${crypto.randomUUID().slice(0, 8)}@example.com`;

  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const status = await page.evaluate(async (address: string) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: address, password: "password123" }),
    });
    return response.status;
  }, email);

  expect(status).toBe(201);
  return email;
}

/** Places an order as a freshly registered customer, returning its number. */
async function placeOrderAsCustomer(page: Page): Promise<string> {
  const email = await registerCustomer(page);

  await page.goto("/products/seasonal-candy-variety-box");
  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  await added;

  await page.goto("/checkout");
  await page.getByLabel("Email", { exact: true }).fill(email);

  // After this account has ordered once it has a saved address, and the form
  // defaults to using it. Fill the new-address fields only when they are shown.
  const savedOption = page.getByRole("radio", { name: "Use a saved address" });
  if ((await savedOption.count()) === 0) {
    await page.getByLabel("Recipient name").fill("A Shopper");
    await page.getByLabel("Phone for delivery").fill("+8801700000000");
    await page.getByLabel("Address", { exact: true }).fill("12 Example Road");
    await page.getByLabel("City").fill("Dhaka");
    await page.getByLabel("District").fill("Dhaka");
  }

  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  const text = await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText();
  return text.match(/ORD-\d{4}-\d{6}/)![0];
}

test("a shopper sees their order in their account", async ({ page }) => {
  const orderNumber = await placeOrderAsCustomer(page);

  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Your orders" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: orderNumber })).toBeVisible();
});

test("a shopper can open their own order and see its progress", async ({
  page,
}) => {
  const orderNumber = await placeOrderAsCustomer(page);

  await page.goto("/account");
  await page.getByRole("link", { name: orderNumber }).click();

  await expect(
    page.getByRole("heading", { name: orderNumber, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Sourcing in the US")).toBeVisible();
  await expect(page.getByText("Delivering to")).toBeVisible();
});

test("a shopper asks to cancel, and the order carries on until staff answer", async ({
  page,
}) => {
  const orderNumber = await placeOrderAsCustomer(page);

  await page.goto("/account");
  await page.getByRole("link", { name: orderNumber }).click();

  await page.getByRole("button", { name: "Ask us to cancel" }).click();
  await page.getByLabel("Reason (optional)").fill("Changed my mind");

  const requested = page.waitForResponse(
    (r) => r.url().includes("/api/orders/") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send the request" }).click();
  expect((await requested).status()).toBe(200);

  // A request, not a cancellation: the panel says it is with us, and the order
  // is still in progress (DECISIONS.md D-014).
  await expect(
    page.getByText(/You asked us to cancel this order/),
  ).toBeVisible();
  await expect(
    page.getByText("This order is no longer in progress."),
  ).toHaveCount(0);
});

test("an anonymous visitor cannot reach the account area", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("staff move an order through the pipeline", async ({ page }) => {
  // Places a whole order, signs in again as staff, then walks the pipeline.
  // It passes comfortably on its own and timed out only under the load of the
  // full suite — a budget problem, not a defect, and the same reason the
  // checkout-walking tests in reviews.spec.ts and shipping.spec.ts are marked.
  test.slow();

  const orderNumber = await placeOrderAsCustomer(page);

  await signIn(page, "staff@example.com");

  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();

  const advanced = page.waitForResponse(
    (r) => r.url().includes("/api/orders/") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Mark payment confirmed" }).click();
  expect((await advanced).status()).toBe(200);

  // The next step is offered; the previous one is not.
  await expect(
    page.getByRole("button", { name: "Mark as sourcing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark payment confirmed" }),
  ).toHaveCount(0);
});

test("the order pipeline filters by status", async ({ page }) => {
  await placeOrderAsCustomer(page);
  await signIn(page, "staff@example.com");

  await page.goto("/admin/orders?status=placed");
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Awaiting payment" }),
  ).toHaveAttribute("aria-current", "page");

  // Asserting which filter is applied, not how many rows it happens to match:
  // other specs move orders through the pipeline in the same database.
  await page.goto("/admin/orders?status=refunded");
  await expect(
    page.getByRole("link", { name: "Refunded" }),
  ).toHaveAttribute("aria-current", "page");
});

/**
 * The server refuses a backward transition even when the request is crafted
 * by hand — the UI simply not offering it is not the control.
 */
test("a backward transition is refused at the API", async ({ page }) => {
  const orderNumber = await placeOrderAsCustomer(page);
  await signIn(page, "staff@example.com");

  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();
  // Wait for the detail page: reading the URL too early yields the list route.
  await page.waitForURL((url) => url.pathname.startsWith("/admin/orders/"));

  const orderId = page.url().split("/").pop()!;

  await page.evaluate(async (id: string) => {
    await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "advance", status: "payment_confirmed" }),
    });
  }, orderId);

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "advance", status: "placed" }),
    });
    return { status: response.status, body: await response.json() };
  }, orderId);

  expect(result.status).toBe(409);
  expect(result.body.error).toMatch(/cannot move to/i);
});

test("a customer cannot advance an order through the API", async ({ page }) => {
  const orderNumber = await placeOrderAsCustomer(page);

  await page.goto("/account");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/account/orders/"));
  const orderId = page.url().split("/").pop()!;

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "advance", status: "delivered" }),
    });
    return { status: response.status };
  }, orderId);

  expect(result.status).toBe(403);
});

test("a customer cannot refund their own order", async ({ page }) => {
  const orderNumber = await placeOrderAsCustomer(page);

  await page.goto("/account");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/account/orders/"));
  const orderId = page.url().split("/").pop()!;

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refund", reason: "I want my money" }),
    });
    return { status: response.status };
  }, orderId);

  expect(result.status).toBe(403);
});
