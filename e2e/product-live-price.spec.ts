import { expect, test } from "@playwright/test";
import { SEEDED_PRODUCT_PATH } from "./helpers/cart";

/**
 * The price beside the title on a phone follows the chosen option (D-047).
 *
 * It is given only the cheapest price and learns the chosen one from the
 * picker's selection event, so a product with hundreds of variants does not
 * send every price twice (PRODUCTION-READINESS 13.1). Before a choice it reads
 * "From"; after one it states that option's price, the same figure the buy
 * box shows.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("the phone price reads From until an option is chosen, then that option's price", async ({ page }) => {
  await page.goto(SEEDED_PRODUCT_PATH);

  // The price sits in the block right after the product name.
  const livePrice = page.locator("h1 + div p").first();
  await expect(livePrice).toBeVisible();
  await expect(livePrice).toContainText("From");
  const cheapest = (await livePrice.locator("span").filter({ hasText: /\d/ }).first().textContent())?.trim();

  const options = page
    .locator("fieldset", { has: page.getByText("Choose an option", { exact: true }) })
    .locator("label")
    .filter({ hasNotText: "Full" });
  if ((await options.count()) === 0) {
    // On a phone the options live in a sheet opened from the buy bar.
    await page.getByRole("button", { name: /Choose|Options|Select/ }).filter({ visible: true }).first().click();
  }
  await options.filter({ visible: true }).first().click();

  await expect(livePrice).not.toContainText("From");
  await expect(livePrice).toContainText(/৳|Tk|BDT/);
  expect(cheapest).toBeTruthy();
});
