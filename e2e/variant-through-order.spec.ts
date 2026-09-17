import { expect, test, type Page } from "@playwright/test";
import { fillGuestCheckout, SEEDED_PRODUCT_PATH } from "./helpers/cart";

/**
 * The option a shopper chooses is the option they get, on every screen after
 * the product page (PRODUCTION-READINESS 15.1): the cart line, checkout, the
 * confirmation, the order in the shop's records, and the staff order view.
 *
 * The seeded candy box comes in Pumpkin Spice and Peppermint. Every other spec
 * takes the first option, so this one takes the second: a line that silently
 * fell back to the first variant would still pass those.
 */

async function signIn(page: Page, email: string) {
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
}

test("the chosen option carries through cart, checkout, the order and the staff view", async ({ page }) => {
  await page.goto(SEEDED_PRODUCT_PATH);

  const options = page
    .locator("fieldset", { has: page.getByText("Choose an option", { exact: true }) })
    .locator("label");
  await options.filter({ hasText: "Peppermint" }).first().click();

  const added = page.waitForResponse(
    (response) => response.url().includes("/api/cart") && response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: /^(Add to cart|Add)$/ })
    .filter({ visible: true })
    .first()
    .click();
  expect((await added).status()).toBe(200);

  // Cart.
  await page.goto("/cart");
  const main = page.getByRole("main");
  await expect(main.getByText(/Peppermint/).first()).toBeVisible();
  await expect(main.getByText(/Pumpkin Spice/)).toHaveCount(0);

  // Checkout.
  await page.goto("/checkout");
  await expect(main.getByText(/Peppermint/).first()).toBeVisible();
  await expect(main.getByText(/Pumpkin Spice/)).toHaveCount(0);

  await fillGuestCheckout(page, { email: `variant-${Date.now()}@example.com` });
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForURL(/\/checkout\/confirmation/);
  const orderNumber = (await page.getByText(/ORD-\d{4}-\d{6}/).first().textContent())!.match(/ORD-\d{4}-\d{6}/)![0];

  // The staff view of the order, which reads the stored snapshot.
  await signIn(page, "staff@example.com");
  await page.goto(`/admin/orders?q=${orderNumber}`);
  await page.getByRole("link", { name: orderNumber }).click();
  await expect(page.getByRole("main").getByText(/Peppermint/).first()).toBeVisible();
  await expect(page.getByRole("main").getByText(/Pumpkin Spice/)).toHaveCount(0);
});
