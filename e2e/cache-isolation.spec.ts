import { expect, test, type Page } from "@playwright/test";
import { addToCart, SEEDED_PRODUCT_PATH } from "./helpers/cart";

/**
 * Nothing about one visitor reaches another through a cached page (D-054).
 *
 * Listings, search results and product content are rendered once and shared.
 * The header's greeting and cart count are read per request behind Suspense.
 * A signed-in customer with something in their cart visits every cached page
 * first, so any entry filled during their requests would be the one a guest
 * is then served.
 */

const CACHED_PAGES = [
  "/",
  "/categories/candy-chocolate",
  "/search?q=candy",
  SEEDED_PRODUCT_PATH,
];

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

test("a guest never sees a signed-in customer's name or cart on cached pages", async ({
  browser,
}) => {
  const customer = await browser.newContext();
  const customerPage = await customer.newPage();
  await signIn(customerPage, "customer@example.com");
  await addToCart(customerPage);

  for (const path of CACHED_PAGES) {
    await customerPage.goto(path);
    const header = customerPage.locator("header").first();
    // The customer's own header does show them, so the check below means something.
    await expect(header.getByText("Nadia").first()).toBeVisible();
    await expect(header.getByRole("link", { name: /Cart\s*,\s*[1-9]\d* items?/ })).toBeVisible();
  }
  await customer.close();

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  for (const path of CACHED_PAGES) {
    const response = await guestPage.goto(path);
    const html = (await response?.text()) ?? "";
    expect(html, `${path} served the customer's name to a guest`).not.toContain("Nadia");
    expect(html, `${path} served the customer's email to a guest`).not.toContain("customer@example.com");

    const header = guestPage.locator("header").first();
    await expect(header.getByRole("link", { name: /Cart\s*,\s*0 items/ })).toBeVisible();
    await expect(header.getByText("Nadia")).toHaveCount(0);
  }
  await guest.close();
});
