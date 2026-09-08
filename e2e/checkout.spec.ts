import { expect, test, type Page } from "@playwright/test";

/**
 * The purchase, end to end, as a shopper performs it.
 *
 * These cover the acceptance criteria in MASTER_PRODUCT_SPEC.md §7: a guest
 * completes a purchase, a duplicate submission creates one order, and a
 * preorder cannot be paid on delivery.
 */

async function addFirstProductToCart(page: Page) {
  await page.goto("/products/seasonal-candy-variety-box");

  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  expect((await added).status()).toBe(200);
}

async function fillGuestCheckout(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Recipient name").fill("A Shopper");
  await page.getByLabel("Phone for delivery").fill("+8801700000000");
  await page.getByLabel("Address", { exact: true }).fill("12 Example Road");
  await page.getByLabel("City").fill("Dhaka");
  await page.getByLabel("District").fill("Dhaka");
}

test("a guest completes a purchase end to end", async ({ page }) => {
  await addFirstProductToCart(page);

  await page.goto("/cart");
  await expect(page.getByRole("heading", { name: "Your cart" })).toBeVisible();
  await expect(page.getByText("BDT 1,850").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();

  await fillGuestCheckout(page, "guest@example.com");
  await page.getByRole("button", { name: "Place order" }).click();

  await page.waitForURL(/\/checkout\/confirmation/);
  await expect(
    page.getByRole("heading", { name: /Thank you/ }),
  ).toBeVisible();
  // The order number is what a guest needs to track it later.
  await expect(page.getByText(/ORD-\d{4}-\d{6}/)).toBeVisible();
});

test("the cart is emptied once the order is placed", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  await fillGuestCheckout(page, "empty-cart@example.com");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  await page.goto("/cart");
  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

/**
 * MASTER_PRODUCT_SPEC.md §7 acceptance criterion: a duplicate submission with
 * the same idempotency key creates one order and one charge.
 */
test("submitting the same order twice creates one order", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");
  await fillGuestCheckout(page, "double@example.com");

  // Capture the payload the form would send, then replay it verbatim.
  let payload: string | null = null;
  await page.route("**/api/checkout", async (route) => {
    payload = route.request().postData();
    await route.continue();
  });

  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  expect(payload).not.toBeNull();

  const replay = await page.evaluate(async (body: string) => {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: response.status, body: await response.json() };
  }, payload!);

  expect(replay.status).toBe(200);
  // The same order comes back rather than a second one being created.
  expect(replay.body.order.reused).toBe(true);
});

test("a preorder cannot be paid cash on delivery", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  // The option is not offered at all for a preorder.
  await expect(
    page.getByRole("radio", { name: "Cash on delivery" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Cash on delivery is not available for preorders/),
  ).toBeVisible();
});

test("the checkout never sends a price to the server", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");
  await fillGuestCheckout(page, "shopper-nine@example.com");

  let payload: string | null = null;
  await page.route("**/api/checkout", async (route) => {
    payload = route.request().postData();
    await route.continue();
  });

  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  // The client sends identifiers and a method — never an amount. Checked as
  // JSON keys, so a value that merely contains one of these words does not
  // make the test pass or fail by accident.
  const keys = Object.keys(JSON.parse(payload!));
  expect(keys.sort()).toEqual(
    ["address", "email", "idempotencyKey", "method"].sort(),
  );
});

test("a tampered total is ignored: the server prices the order", async ({
  page,
}) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "bkash",
        email: "tamper@example.com",
        idempotencyKey: crypto.randomUUID(),
        totalBdt: 1,
        address: {
          recipientName: "A Shopper",
          phone: "+8801700000000",
          addressLine1: "12 Example Road",
          city: "Dhaka",
          district: "Dhaka",
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  });

  // The unexpected field is rejected outright rather than quietly ignored.
  expect(result.status).toBe(400);
});

test("the cart shows a running total and updates on quantity change", async ({
  page,
}) => {
  await addFirstProductToCart(page);
  await page.goto("/cart");

  await expect(page.getByText("BDT 1,850").first()).toBeVisible();

  const updated = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "PATCH",
  );
  await page.getByLabel(/^Quantity of/).fill("3");
  await page.getByLabel(/^Quantity of/).blur();
  await updated;

  await expect(page.getByText("BDT 5,550").first()).toBeVisible();
});

test("removing the last item returns the empty state", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/cart");

  const removed = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Remove" }).click();
  await removed;

  await expect(page.getByText("Your cart is empty.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse products" })).toBeVisible();
});

test("an order can be tracked with its number and email", async ({ page }) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");
  await fillGuestCheckout(page, "tracked@example.com");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  const orderNumber = (
    await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText()
  ).match(/ORD-\d{4}-\d{6}/)![0];

  await page.goto("/orders/lookup");
  await page.getByLabel("Order number").fill(orderNumber);
  await page.getByLabel("Email").fill("tracked@example.com");
  await page.getByRole("button", { name: "Find my order" }).click();

  await expect(
    page.getByRole("heading", { name: `Order ${orderNumber}` }),
  ).toBeVisible();
  await expect(page.getByText("Placed", { exact: true })).toBeVisible();
});

/** The order number alone must not reveal someone else's order. */
test("tracking needs the right email, not just the order number", async ({
  page,
}) => {
  await addFirstProductToCart(page);
  await page.goto("/checkout");
  await fillGuestCheckout(page, "private@example.com");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  const orderNumber = (
    await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText()
  ).match(/ORD-\d{4}-\d{6}/)![0];

  await page.goto(
    `/orders/lookup?order=${orderNumber}&email=someone-else@example.com`,
  );

  await expect(
    page.getByText("We could not find an order with those details."),
  ).toBeVisible();
});
