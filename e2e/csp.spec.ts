import { expect, test, type Page } from "@playwright/test";

/**
 * The nonce Content-Security-Policy (proxy.ts) blocks nothing the site itself
 * needs: every script Next.js renders carries the nonce, pages hydrate, and
 * the browser reports no violation on the storefront, checkout or admin
 * (PRODUCTION-READINESS 20.1).
 */

function watchViolations(page: Page) {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(text)) violations.push(text);
  });
  return violations;
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
}

test("pages carry a nonce policy and hydrate without violations", async ({ page }) => {
  const violations = watchViolations(page);

  const response = await page.goto("/products/seasonal-candy-variety-box");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toMatch(/'nonce-[^']+'/);
  if (process.env.E2E_PRODUCTION === "1") expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);

  // Hydrated: choosing an option is handled by React.
  const options = page
    .locator("fieldset", { has: page.getByText("Choose an option", { exact: true }) })
    .locator("label");
  await options.first().click();
  await expect(page.getByRole("button", { name: /^(Add to cart|Add)$/ }).filter({ visible: true }).first()).toBeEnabled();

  for (const path of ["/", "/search?q=candy", "/cart", "/checkout", "/help"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }

  expect(violations).toEqual([]);
});

test("the admin area runs under the same policy without violations", async ({ page }) => {
  const violations = watchViolations(page);
  await signIn(page, "staff@example.com");
  for (const path of ["/admin", "/admin/products", "/admin/orders"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(violations).toEqual([]);
});

test("a cross-site form post to the API is refused", async ({ request, baseURL }) => {
  const response = await request.post(`${baseURL}/api/cart`, {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { variantId: "00000000-0000-4000-8000-000000000000", quantity: 1 },
  });
  expect(response.status()).toBe(403);
});
