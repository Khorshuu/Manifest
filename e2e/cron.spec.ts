import { expect, test, type Page } from "@playwright/test";
import { addToCart, fillGuestCheckout } from "./helpers/cart";

/**
 * The scheduled sweep.
 *
 * It is not authenticated as a person — a scheduler is not one — so the thing
 * worth testing hardest is that the shared secret is actually required, and
 * that no session, however privileged, is a substitute for it.
 */

const SECRET = "test-cron-secret";

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

  await addToCart(page);

  await page.goto("/checkout");
  await fillGuestCheckout(page, { email: email, name: "A Shopper" });
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
  // Customer messages have their own tab; the default view is the staff
  // inbox, which also names the order ("New order …") but has no status.
  await page.goto("/admin/notifications?tab=messages");

  const row = page.getByRole("listitem").filter({ hasText: orderNumber });
  await expect(row.first()).toContainText("sent");
});
