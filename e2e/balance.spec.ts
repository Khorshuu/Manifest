import { expect, test, type Page } from "@playwright/test";

/**
 * Taking the balance on a deposit order, as staff drive it.
 *
 * DECISIONS.md D-012: the balance is collected when a member of staff presses
 * a button, never automatically. These assert the screen and — because this is
 * the one place in the application where a duplicate costs a real person real
 * money — the rules at the API, whether or not the form is involved.
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
    (r) =>
      r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function registerCustomer(page: Page): Promise<string> {
  const email = `deposit-${crypto.randomUUID().slice(0, 8)}@example.com`;

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

/**
 * A deposit product of this file's own, built once per worker.
 *
 * Deliberately not the seeded headphones: that batch holds seven places and
 * these tests would exhaust it, so checkout would start failing for a reason
 * that has nothing to do with balances. Building it once rather than per test
 * matters too — it takes a dozen navigations, and repeating that in every test
 * was enough extra load to push other specs past their timeouts. Fifty places
 * is plenty for every test here to get its own order.
 */
let sharedDepositVariant: string | null = null;

async function depositVariantId(page: Page): Promise<string> {
  if (sharedDepositVariant) return sharedDepositVariant;
  sharedDepositVariant = await createDepositProduct(page);
  return sharedDepositVariant;
}

async function createDepositProduct(page: Page): Promise<string> {
  // Staff first: the product has to exist before anyone can buy it.
  await signIn(page, "staff@example.com");

  const title = `Deposit Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Status").selectOption("preorder_open");
  await page.getByRole("button", { name: "Save product" }).click();
  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  const productUrl = page.url().split("?")[0];

  // One plain variant, priced, then put on a 40% deposit with real capacity.
  await page.goto(`${productUrl}/variants`);
  // No variant group: one plain variant, created with its price.
  await page.getByLabel("Price (৳)").first().fill("10000");
  const generated = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Set price" }).click();
  await generated;

  // The id is read off the windows screen rather than out of the generate
  // response, whose shape is that endpoint's business and not this test's.
  await page.goto(`${productUrl}/windows`);
  const variantId = (await page
    .locator('input[name="capacity"]')
    .first()
    .getAttribute("id"))!.replace(/^capacity-/, "");

  const patched = await page.evaluate(
    async ([id, closesAt]) => {
      const response = await fetch(`/api/admin/variants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentMode: "deposit",
          depositPercent: 40,
          preorderCapacity: 50,
          preorderClosesAt: closesAt,
        }),
      });
      return response.status;
    },
    [
      variantId,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ] as const,
  );
  expect(patched).toBe(200);

  return variantId;
}

/**
 * A fresh customer with one deposit order, placed through the API.
 *
 * Deliberately not through the checkout form. What is under test here is the
 * balance, and checkout has its own suite that walks the whole form — driving
 * it again in every one of these tests added enough load to push unrelated
 * specs past their timeouts, which is a slow way to test something twice.
 */
async function placeDepositOrder(page: Page): Promise<string> {
  const variantId = await depositVariantId(page);
  const email = await registerCustomer(page);

  const placed = await page.evaluate(
    async ([variant, address]) => {
      const added = await fetch("/api/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId: variant, quantity: 1 }),
      });
      if (!added.ok) {
        return { step: "cart", status: added.status, body: await added.text() };
      }

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

      return {
        step: "checkout",
        status: response.status,
        body: await response.text(),
      };
    },
    [variantId, email] as const,
  );

  expect(
    placed.status,
    `${placed.step} failed: ${placed.body}`,
  ).toBeLessThan(300);

  return JSON.parse(placed.body).order.orderNumber as string;
}

/** Opens the admin page for an order and returns its id. */
async function openAdminOrder(page: Page, orderNumber: string) {
  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  return page.url().split("/").pop()!;
}

test("staff see what is outstanding and take it", async ({ page }) => {
  test.slow();

  const orderNumber = await placeDepositOrder(page);
  await signIn(page, "staff@example.com");
  await openAdminOrder(page, orderNumber);

  // The three figures, stated before anything is pressed.
  const payment = page.getByRole("heading", { name: "Payment" }).locator("..");
  await expect(payment.getByText("Outstanding")).toBeVisible();

  await page.getByRole("button", { name: "Take balance payment" }).click();
  await page.getByRole("button", { name: "Yes, take the balance" }).click();

  await expect(page.getByText(/Balance of .* received/)).toBeVisible();

  // Read back from the server, not from the optimistic message.
  await page.reload();
  await expect(page.getByText("This order is paid in full.")).toBeVisible();
});

/**
 * The rule that costs money if it is wrong. Two requests must take the balance
 * once, and the second has to say so rather than failing.
 */
test("the same balance cannot be taken twice", async ({ page }) => {
  test.slow();

  const orderNumber = await placeDepositOrder(page);
  await signIn(page, "staff@example.com");
  const orderId = await openAdminOrder(page, orderNumber);

  const results = await page.evaluate(async (id: string) => {
    const take = async () => {
      const response = await fetch(`/api/orders/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "take_balance" }),
      });
      return { status: response.status, body: await response.json() };
    };

    const first = await take();
    const second = await take();
    return { first, second };
  }, orderId);

  expect(results.first.status).toBe(200);
  expect(results.first.body.result.alreadyPaid).toBe(false);

  expect(results.second.status).toBe(200);
  expect(results.second.body.result.alreadyPaid).toBe(true);
  expect(results.second.body.result.amountBdt).toBe(
    results.first.body.result.amountBdt,
  );
});

/**
 * Everything the endpoint must refuse, against one order.
 *
 * Three probes in one test on purpose. Each needs an order that still owes
 * something and none of them consumes it, so splitting them would mean three
 * whole checkouts to assert three status codes — and this file walking that
 * many checkouts is what pushed the rest of the suite past its timeouts.
 */
test("the endpoint refuses what it should", async ({ page }) => {
  test.slow();

  const orderNumber = await placeDepositOrder(page);
  await signIn(page, "staff@example.com");
  const orderId = await openAdminOrder(page, orderNumber);

  const take = async (body: unknown) =>
    page.evaluate(
      async ([id, payload]) => {
        const response = await fetch(`/api/orders/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return response.status;
      },
      [orderId, body] as const,
    );

  // The amount is the server's to decide. A request that could name a figure
  // would be a request that could name the wrong one — so an extra field is
  // refused outright rather than quietly ignored.
  expect(await take({ action: "take_balance", amountBdt: 1 })).toBe(400);

  // Staff only.
  await signIn(page, "customer@example.com");
  expect(await take({ action: "take_balance" })).toBe(403);

  // 401 and 403 mean different things: this caller has not identified itself.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  expect(await take({ action: "take_balance" })).toBe(401);
});
