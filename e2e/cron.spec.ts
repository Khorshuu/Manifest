import { expect, test, type Page } from "@playwright/test";

/**
 * The scheduled sweep.
 *
 * It is not authenticated as a person — a scheduler is not one — so the thing
 * worth testing hardest is that the shared secret is actually required, and
 * that no session, however privileged, is a substitute for it.
 */

const SECRET = "test-cron-secret";

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

test("the sweep runs with the right secret and reports what it did", async ({
  request,
}) => {
  const response = await request.get("/api/cron/maintenance", {
    headers: { Authorization: `Bearer ${SECRET}` },
  });

  expect(response.status()).toBe(200);

  const body = await response.json();
  // A real report, not a fixed acknowledgement.
  expect(body.delivery).toMatchObject({
    attempted: expect.any(Number),
    sent: expect.any(Number),
    failed: expect.any(Number),
  });
  expect(typeof body.prunedRateLimits).toBe("number");
});

test("a scheduler may POST as well as GET", async ({ request }) => {
  const response = await request.post("/api/cron/maintenance", {
    headers: { Authorization: `Bearer ${SECRET}` },
  });

  expect(response.status()).toBe(200);
});

test("it refuses a request with no secret", async ({ request }) => {
  const response = await request.get("/api/cron/maintenance");
  expect(response.status()).toBe(401);
});

test("it refuses a wrong secret", async ({ request }) => {
  const response = await request.get("/api/cron/maintenance", {
    headers: { Authorization: "Bearer not-the-secret" },
  });

  expect(response.status()).toBe(401);
});

test("it refuses a secret sent without the Bearer prefix", async ({
  request,
}) => {
  const response = await request.get("/api/cron/maintenance", {
    headers: { Authorization: SECRET },
  });

  expect(response.status()).toBe(401);
});

/** A signed-in super admin is still not a scheduler. */
test("a session is not a substitute for the secret", async ({ page }) => {
  await signIn(page, "admin@example.com");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/cron/maintenance");
    return response.status;
  });

  expect(status).toBe(401);
});

test("an order placed now is delivered by the sweep", async ({
  page,
  request,
}) => {
  test.slow();

  const email = `cron-${crypto.randomUUID().slice(0, 8)}@example.com`;

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

  const orderNumber = (
    await page.getByText(/ORD-\d{4}-\d{6}/).first().innerText()
  ).match(/ORD-\d{4}-\d{6}/)![0];

  // Whether this order's own request delivered it or the sweep did, the row
  // ends up sent — which is the guarantee, rather than which one got there.
  const response = await request.get("/api/cron/maintenance", {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  expect(response.status()).toBe(200);

  await signIn(page, "staff@example.com");
  await page.goto("/admin/notifications");

  const row = page.getByRole("listitem").filter({ hasText: orderNumber });
  await expect(row.first()).toContainText("sent");
});
