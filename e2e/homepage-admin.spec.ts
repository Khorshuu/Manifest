import { expect, test, type Page } from "@playwright/test";

/**
 * The homepage, changed by staff and seen by a shopper.
 *
 * This is the test that stops the admin page being a fake settings panel: it
 * uses the real controls, saves, then loads the storefront as a visitor with no
 * session and asserts the change is there. Nothing is stubbed, and the last
 * step puts the homepage back so the rest of the suite sees what it expects.
 */

async function signIn(page: Page, email: string) {
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

const showcaseSaved = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/homepage/showcase") &&
      r.request().method() === "PATCH",
  );

test.describe.configure({ mode: "serial" });

test("staff choose the row and the storefront shows it", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/homepage");

  /*
   * The product is taken from the control's own options rather than named
   * here. This database accumulates products as the suite runs, so any
   * particular seeded title may be off the end of the list — and what is being
   * tested is that choosing *a* product works, not that a specific one exists.
   */
  const select = page.getByLabel("Add a product");
  const option = select.locator("option:not([value=''])").first();
  const slug = await option.getAttribute("value");
  const label = await option.innerText();
  const title = label.includes("—") ? label.split("—").pop()!.trim() : label.trim();

  await select.selectOption(slug!);

  const added = showcaseSaved(page);
  await page.getByRole("button", { name: "Add to the row" }).click();
  expect((await added).ok()).toBe(true);

  await page.goto("/");
  const showcase = page.getByRole("region", { name: "Featured products" });
  await expect(
    showcase.getByRole("link", { name: new RegExp(title.slice(0, 24)) }).first(),
  ).toBeVisible();

  // Four cards, whatever the catalogue holds. Scoped to the row itself: the
  // section also carries a link to every open window.
  await expect(showcase.getByRole("listitem")).toHaveCount(4);

  // And put it back: the row item carrying this product, not whichever is
  // first, because another run may have left products in the row.
  await page.goto("/admin/homepage");
  const removed = showcaseSaved(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: title })
    .getByRole("button", { name: "Remove" })
    .first()
    .click();
  expect((await removed).ok()).toBe(true);
});

/** The photograph carries nothing: no headline, no price panel, no button. */
test("the hero image is unobstructed", async ({ page }) => {
  await page.goto("/");

  const hero = page.getByRole("region", { name: "Featured photograph" });
  await expect(hero).toBeVisible();

  // Nothing to read and nothing to press inside the image itself.
  await expect(hero.getByRole("link")).toHaveCount(0);
  await expect(hero.getByRole("button")).toHaveCount(0);
  await expect(hero.getByRole("heading")).toHaveCount(0);
  expect((await hero.innerText()).trim()).toBe("");
});

test("a customer cannot reach the homepage settings", async ({ page }) => {
  await signIn(page, "customer@example.com");

  // The page itself redirects away, and the API refuses the same request the
  // admin page would have made — the second is the one that matters.
  await page.goto("/admin/homepage");
  await expect(page).not.toHaveURL(/\/admin/);

  const hero = await page.request.patch("/api/admin/homepage/hero", {
    data: { focalX: 10 },
  });
  expect(hero.status()).toBe(403);

  const showcase = await page.request.patch("/api/admin/homepage/showcase", {
    data: { action: "add", slug: "seasonal-candy-variety-box" },
  });
  expect(showcase.status()).toBe(403);
});
