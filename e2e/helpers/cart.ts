import { expect, type Page } from "@playwright/test";

/** The seeded product most specs buy: several flavours, so an option is owed. */
export const SEEDED_PRODUCT_PATH = "/products/seasonal-candy-variety-box";

/**
 * Puts one of a product into the cart the way a shopper does.
 *
 * A product with more than one option starts with none chosen (D-043), and
 * pressing Add with nothing chosen asks for a choice instead of adding — so a
 * helper that only pressed the button waited forever for a request the page
 * correctly never sent. The first option still on offer is chosen first, then
 * whichever add button this viewport shows: the panel's on a desktop, the
 * sticky bar's on a phone.
 */
export async function addToCart(page: Page, path = SEEDED_PRODUCT_PATH) {
  await page.goto(path);

  const options = page
    .locator("fieldset", { has: page.getByText("Choose an option", { exact: true }) })
    .locator("label")
    .filter({ hasNotText: "Full" });
  if ((await options.count()) > 0) await options.first().click();

  const added = page.waitForResponse(
    (response) => response.url().includes("/api/cart") && response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: /^(Add to cart|Add)$/ })
    .filter({ visible: true })
    .first()
    .click();
  expect((await added).status()).toBe(200);
}

/**
 * Fills the guest checkout form.
 *
 * Scoped to the page's main region: the header's sign-in dialog is always in
 * the document (D-050) and has an Email field of its own, so an unscoped
 * "Email" label matches two inputs.
 */
export async function fillGuestCheckout(
  page: Page,
  details: { email: string; name?: string },
) {
  const main = page.getByRole("main");
  await main.getByLabel("Email", { exact: true }).fill(details.email);
  await main.getByLabel("Recipient name").fill(details.name ?? "A Shopper");
  await main.getByLabel("Phone for delivery").fill("+8801700000000");
  await main.getByLabel("Address", { exact: true }).fill("12 Example Road");
  await main.getByLabel("City").fill("Dhaka");
  await main.getByLabel("District").fill("Dhaka");
}
