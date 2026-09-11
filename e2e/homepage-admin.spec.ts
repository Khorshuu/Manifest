import { expect, test, type Page } from "@playwright/test";

/**
 * The homepage campaigns, changed by staff and seen by a shopper.
 *
 * Uses the real controls on /admin/homepage, then loads the storefront with no
 * session and asserts the slide is there with its own hero link and tile. The
 * last step removes what it added, which switches the slide off again, so the
 * rest of the suite sees the homepage it expects.
 */

// A valid 1x1 PNG: the media provider checks the bytes, not the file name.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const campaignCall = (page: Page, path = "/api/admin/homepage/campaigns") =>
  page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() !== "GET");

test.describe.configure({ mode: "serial" });

test("staff build a slide and the storefront shows it, hero and tile together", async ({ page }) => {
  // Each device project gets its own slot and its own words: the projects run
  // in parallel against one database.
  const slot = test.info().project.name === "mobile" ? 3 : 4;
  const tag = crypto.randomUUID().slice(0, 6);
  const tileTitle = `E2E Tile ${tag}`;

  await signIn(page, "staff@example.com");
  await page.goto("/admin/homepage");

  await page.getByRole("tab", { name: new RegExp(`Slide ${slot + 1}`) }).click();

  let uploaded = campaignCall(page, "/api/admin/homepage/campaigns/image");
  await page.locator(`#hero-${slot}`).setInputFiles({ name: "hero.png", mimeType: "image/png", buffer: PNG });
  expect((await uploaded).ok()).toBe(true);

  uploaded = campaignCall(page, "/api/admin/homepage/campaigns/image");
  await page.locator(`#tile-${slot}-0`).setInputFiles({ name: "tile.png", mimeType: "image/png", buffer: PNG });
  expect((await uploaded).ok()).toBe(true);

  await page.getByLabel("Internal name").fill(`E2E ${tag}`);
  await page.getByLabel("Hero destination").fill("/search?sort=newest");
  await page.locator(`#t-title-${slot}-0`).fill(tileTitle);
  await page.locator(`#t-url-${slot}-0`).fill("/search");

  let saved = campaignCall(page);
  await page.getByRole("button", { name: "Save slide" }).click();
  expect((await saved).ok()).toBe(true);

  saved = campaignCall(page);
  // The switch's visible label, which is what a person taps.
  await page.getByText("Inactive", { exact: true }).click();
  expect((await saved).ok()).toBe(true);

  // The shopper's view, with no session.
  const shopper = await page.context().browser()!.newPage();
  await shopper.goto("/");
  const slider = shopper.getByRole("region", { name: "Promotions" });
  await expect(slider).toBeVisible();

  // Move through the slides until this one is in view; its tile arrives with it.
  for (let step = 0; step < 6; step += 1) {
    if (await shopper.getByRole("link", { name: tileTitle }).isVisible()) break;
    await shopper.getByRole("button", { name: "Next promotion" }).click();
  }
  const tile = shopper.getByRole("link", { name: tileTitle });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("href", "/search");
  await expect(
    slider.locator('[aria-hidden="false"] a[href="/search?sort=newest"]'),
  ).toHaveCount(1);
  await shopper.close();

  // Put it back: removing the hero switches the slide off.
  saved = campaignCall(page, "/api/admin/homepage/campaigns/image");
  await page.getByRole("button", { name: "Remove" }).first().click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Inactive")).toBeVisible();
});

test("an unused slot never appears as a blank slide", async ({ page }) => {
  await page.goto("/");
  const slides = page.locator('[aria-roledescription="slide"]');
  const count = await slides.count();
  for (let index = 0; index < count; index += 1) {
    await expect(slides.nth(index).locator("img").first()).toHaveAttribute("src", /.+/);
  }
});

test("a customer cannot reach the homepage settings", async ({ page }) => {
  await signIn(page, "customer@example.com");

  await page.goto("/admin/homepage");
  await expect(page).not.toHaveURL(/\/admin/);

  const patch = await page.request.patch("/api/admin/homepage/campaigns", {
    data: { action: "update", slot: 0, patch: { name: "x" } },
  });
  expect(patch.status()).toBe(403);
});
