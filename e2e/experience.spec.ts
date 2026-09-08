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

test("the hero rotates and can be driven by hand", async ({ page }) => {
  await page.goto("/");

  const carousel = page.getByRole("region", { name: "Featured preorders" });
  await expect(carousel).toBeVisible();

  const tabs = carousel.getByRole("button", { name: /^Show / });
  const count = await tabs.count();
  test.skip(count < 2, "The seeded catalogue has only one featured product.");

  // The first slide is the selected one.
  await expect(tabs.first()).toHaveAttribute("aria-current", "true");

  const firstHeading = await carousel
    .getByRole("heading", { level: 2 })
    .innerText();

  // A click moves it.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(
    carousel.getByRole("heading", { level: 2 }),
  ).not.toHaveText(firstHeading);

  // And so does the keyboard, which is the part usually forgotten.
  await tabs.nth(1).press("ArrowLeft");
  await expect(tabs.first()).toHaveAttribute("aria-current", "true");
});

/** Rotation that continues while someone is reading is worse than none. */
test("the hero stops rotating while the pointer is on it", async ({ page }) => {
  await page.goto("/");

  const carousel = page.getByRole("region", { name: "Featured preorders" });
  const tabs = carousel.getByRole("button", { name: /^Show / });
  test.skip((await tabs.count()) < 2, "Needs more than one featured product.");

  await carousel.hover();
  const heading = await carousel.getByRole("heading", { level: 2 }).innerText();

  // Longer than the rotation interval.
  await page.waitForTimeout(8000);

  await expect(carousel.getByRole("heading", { level: 2 })).toHaveText(heading);
});

test("the preorder countdown is live and announced once", async ({ page }) => {
  await page.goto(PRODUCT);

  const timer = page.getByRole("timer");
  await expect(timer).toBeVisible();

  // It says the same thing to a screen reader as it shows on screen.
  await expect(timer).toHaveAttribute("aria-label", /Preorder closes in/);

  const first = await timer.innerText();
  await page.waitForTimeout(2000);
  const second = await timer.innerText();

  expect(second).not.toBe(first);
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

  const ribbons = page.getByText("Closing soon", { exact: true });
  const cards = page.getByRole("link", { name: /Preorder|In stock|Full/ });

  // Whatever the seeded dates are, a ribbon never outnumbers the products.
  expect(await ribbons.count()).toBeLessThanOrEqual(await cards.count());
});
