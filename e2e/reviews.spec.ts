import { expect, test, type Page } from "@playwright/test";

/**
 * Reviews, end to end.
 *
 * The whole point of the feature is the two gates: a review needs a delivered
 * order behind it, and a human in front of it. Both are checked here through
 * the real pipeline rather than by writing rows.
 */

const PRODUCT = "/products/seasonal-candy-variety-box";

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

/** A fresh account per test: a signed-in account has one cart. */
async function registerCustomer(page: Page): Promise<string> {
  const email = `reviewer-${crypto.randomUUID().slice(0, 8)}@example.com`;

  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const status = await page.evaluate(async (address: string) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Shopper", email: address, password: "password123" }),
    });
    return response.status;
  }, email);

  expect(status).toBe(201);
  return email;
}

async function buyCandy(page: Page, email: string): Promise<string> {
  await page.goto(PRODUCT);
  const added = page.waitForResponse(
    (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  await added;

  await page.goto("/checkout");
  await page.getByLabel("Email", { exact: true }).fill(email);

  const savedOption = page.getByRole("radio", { name: "Use a saved address" });
  if ((await savedOption.count()) === 0) {
    await page.getByLabel("Recipient name").fill("A Reviewer");
    await page.getByLabel("Phone for delivery").fill("+8801700000000");
    await page.getByLabel("Address", { exact: true }).fill("12 Example Road");
    await page.getByLabel("City").fill("Dhaka");
    await page.getByLabel("District").fill("Dhaka");
  }

  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);

  return (await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText()).match(
    /ORD-\d{4}-\d{6}/,
  )![0];
}

/** Walks an order all the way to delivered, as staff would. */
async function deliver(page: Page, orderNumber: string) {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/orders");
  await page.getByRole("link", { name: orderNumber }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/orders/"));

  for (const stage of [
    "Mark payment confirmed",
    "Mark as sourcing",
    "Mark shipped from the US",
    "Mark in customs",
    "Mark out for delivery",
    "Mark delivered",
  ]) {
    const advanced = page.waitForResponse(
      (r) => r.url().includes("/api/orders/") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: stage }).click();
    expect((await advanced).status(), `${stage} should succeed`).toBe(200);
  }
}

test("a delivered customer writes a review, and staff publish it", async ({
  page,
}) => {
  // Six status transitions plus three sign-ins: slow by construction, and it
  // runs alongside the rest of the suite.
  test.slow();

  const email = await registerCustomer(page);
  const orderNumber = await buyCandy(page, email);
  await deliver(page, orderNumber);

  // The form only appears once the order has actually arrived.
  await signIn(page, email);
  await page.goto(PRODUCT);

  const headline = `Arrived sealed ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole("radio", { name: "4", exact: true }).check();
  await page.getByLabel("Headline").fill(headline);
  await page
    .getByLabel("What should other shoppers know?")
    .fill("Exactly what was described, and it got here intact.");

  const submitted = page.waitForResponse(
    (r) => r.url().includes("/api/reviews") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit review" }).click();
  expect((await submitted).status()).toBe(201);

  // Pending: nothing public yet.
  await page.goto(PRODUCT);
  await expect(page.getByText(headline)).toHaveCount(0);

  await signIn(page, "staff@example.com");
  await page.goto("/admin/reviews?status=pending");
  const row = page.getByRole("listitem").filter({ hasText: headline });
  await expect(row).toBeVisible();
  await expect(row).toContainText(email);

  const approved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/reviews/") &&
      r.request().method() === "POST",
  );
  await row.getByRole("button", { name: "Approve" }).click();
  expect((await approved).status()).toBe(200);

  // Public now, and to a visitor who is not signed in at all.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(PRODUCT);
  await expect(page.getByText(headline)).toBeVisible();
  await expect(page.getByText("Verified purchase").first()).toBeVisible();
});

test("someone who has not received the product cannot review it", async ({
  page,
}) => {
  const email = await registerCustomer(page);
  await signIn(page, email);

  await page.goto(PRODUCT);
  // No form is offered.
  await expect(
    page.getByRole("button", { name: "Submit review" }),
  ).toHaveCount(0);
  await expect(page.getByText("Reviews come from delivered orders only.")).toBeVisible();

  // And the API refuses them if they ask anyway.
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: "00000000-0000-0000-0000-000000000000",
        rating: 5,
      }),
    });
    return response.status;
  });

  expect(status).toBe(400);
});

test("an anonymous visitor is asked to sign in rather than shown a form", async ({
  page,
}) => {
  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(PRODUCT);

  await expect(
    page.getByRole("link", { name: "Sign in" }).last(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit review" }),
  ).toHaveCount(0);
});

test("a customer cannot moderate reviews", async ({ page }) => {
  const email = await registerCustomer(page);
  await signIn(page, email);

  await page.goto("/admin/reviews");
  await expect(page).not.toHaveURL(/\/admin\/reviews/);

  const status = await page.evaluate(async () => {
    const response = await fetch(
      "/api/admin/reviews/00000000-0000-0000-0000-000000000000",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      },
    );
    return response.status;
  });

  expect(status).toBe(403);
});
