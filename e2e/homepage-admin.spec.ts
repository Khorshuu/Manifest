import { expect, test, type Page } from "@playwright/test";

/**
 * The homepage hero, changed by staff and seen by a shopper.
 *
 * This is the test that stops the admin page being a fake settings panel: it
 * types into the real form, saves, then loads the storefront as a visitor with
 * no session and asserts the words are there. Nothing is stubbed, and the last
 * step puts the hero back so the rest of the suite sees what it expects.
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

const DEFAULT_HEADLINE = "American goods, landed in Bangladesh";

test.describe.configure({ mode: "serial" });

test("staff change the hero and the storefront shows it", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/homepage");

  const headline = page.getByLabel("Headline");
  await expect(headline).toHaveValue(DEFAULT_HEADLINE);

  await headline.fill("Sourced in Vermont, opened in Dhaka");
  await page.getByLabel("Eyebrow").fill("A new batch has landed");

  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/homepage/hero") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Sourced in Vermont, opened in Dhaka",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByText("A new batch has landed")).toBeVisible();

  // And put it back, so the rest of the suite sees the hero it expects.
  await page.goto("/admin/homepage");
  await page.getByLabel("Headline").fill(DEFAULT_HEADLINE);
  await page.getByLabel("Eyebrow").fill("");
  const restored = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/homepage/hero") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await restored).ok()).toBe(true);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: DEFAULT_HEADLINE, level: 1 }),
  ).toBeVisible();
});

test("a customer cannot reach the hero settings", async ({ page }) => {
  await signIn(page, "customer@example.com");

  // The page itself redirects away, and the API refuses the same request the
  // admin page would have made — the second is the one that matters.
  await page.goto("/admin/homepage");
  await expect(page).not.toHaveURL(/\/admin/);

  const response = await page.request.patch("/api/admin/homepage/hero", {
    data: { headline: "Mine now" },
  });
  expect(response.status()).toBe(403);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: DEFAULT_HEADLINE, level: 1 }),
  ).toBeVisible();
});
