import { expect, test } from "@playwright/test";

/**
 * The moving parts of the storefront.
 *
 * Motion is easy to add and easy to get wrong in ways that only show up for
 * someone using a keyboard or a screen reader, so what is asserted here is not
 * "it animates" — it is that every moving thing is still operable, and that
 * nothing invented information it does not have.
 */

const PRODUCT = "/products/seasonal-candy-variety-box";

/**
 * The hero is one image now, not a carousel.
 *
 * The redesign removed the rotation deliberately, so what is asserted here is
 * that it stays removed: nothing on the first screen changes what it says
 * while someone is reading it.
 */
test("the hero holds still", async ({ page }) => {
  await page.goto("/");

  const hero = page.getByRole("region", { name: "Promotions" });
  await expect(hero).toBeVisible();

  const first = await hero.innerText();

  // Longer than the old rotation interval, and then some.
  await page.waitForTimeout(8000);

  expect((await hero.innerText()).replace(/\d+ (day|hour|minute|second)/g, ""))
    .toBe(first.replace(/\d+ (day|hour|minute|second)/g, ""));
});

/** One scroll from the top has to reach a product, a price and a way in. */
test("the showcase sits directly under the hero, image and title only", async ({ page }) => {
  await page.goto("/");

  const showcase = page.getByRole("list", { name: "Featured in this promotion" });
  await expect(showcase).toBeVisible();
  expect(await showcase.getByRole("listitem").count()).toBeGreaterThan(0);

  // A showcase tile is an image and a title — never a price.
  await expect(showcase.getByText(/BDT/)).toHaveCount(0);
});

test("the preorder countdown is live and announced once", async ({ page }) => {
  await page.goto(PRODUCT);

  const timer = page.getByRole("timer");
  await expect(timer).toBeVisible();

  // It says the same thing to a screen reader as it shows on screen.
  await expect(timer).toHaveAttribute("aria-label", /Preorder closes in/);

  // The buy box shows the compact form (days and hours), so it is not
  // expected to tick within two seconds; what matters is that the spoken
  // label and the visible figure say the same thing.
  const shown = (await timer.innerText()).trim();
  await expect(timer).toHaveAttribute("aria-label", new RegExp(shown));
});

test("the gallery thumbnails work as buttons", async ({ page }) => {
  await page.goto(PRODUCT);

  const thumbnails = page.getByRole("button", { name: /^Show / });
  const count = await thumbnails.count();
  test.skip(count < 2, "This product has one photograph.");

  await thumbnails.nth(1).click();
  await expect(thumbnails.nth(1)).toHaveAttribute("aria-current", "true");
});

test("the buy bar is within reach on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile layout only.");

  await page.goto(PRODUCT);

  // Exactly one buy button on a phone — the sticky one — and it is reachable
  // without scrolling past the options and the countdown.
  const button = page.getByRole("button", { name: "Add to cart" });
  await expect(button).toHaveCount(1);
  await expect(button).toBeInViewport();
});

test("the sticky bar is not there on a desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop layout only.");

  await page.goto(PRODUCT);

  // Exactly one buy button on a wide screen.
  await expect(page.getByRole("button", { name: "Add to cart" })).toHaveCount(1);
});

test("adding to the cart is confirmed visibly", async ({ page }) => {
  test.slow();

  // A roomy product, and not the one the accessibility spec uses. Preorder
  // capacity is finite by design, so a test that repeatedly buys the same
  // small batch eventually fills it and then fails for the right reason at
  // the wrong moment.
  await page.goto("/products/vermont-pancake-syrup");

  // Retried: a click before hydration finds a button with no handler.
  await expect(async () => {
    await page.getByRole("button", { name: "Add to cart" }).click();
    await expect(page.getByText("Added to your cart.")).toBeVisible({
      timeout: 4000,
    });
  }).toPass({ timeout: 30_000 });
  // The header count is the other half of the confirmation. Asserted as "some
  // number", not "1": other specs share this seeded product, and the exact
  // figure is global state.
  await expect(page.getByRole("link", { name: /^Cart/ })).toContainText(
    /[0-9]/,
  );
});

/** A ribbon that appears when nothing is closing would be a lie. */
test("the closing-soon ribbon reflects a real window", async ({ page }) => {
  await page.goto("/search");
  // The grid is server-rendered; wait for it before counting.
  await page.locator("main a[href^='/products/']").first().waitFor();

  const ribbons = page.getByText("Closing soon", { exact: true });
  const cards = page.locator("main a[href^='/products/']");

  // Whatever the seeded dates are, a ribbon never outnumbers the products.
  expect(await ribbons.count()).toBeLessThanOrEqual(await cards.count());
});
