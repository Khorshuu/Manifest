import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The accessibility audit MASTER_PRODUCT_SPEC.md section 7 asks for by name:
 * "search, browse, cart and checkout pass an accessibility audit at AA".
 *
 * The structural rules were already asserted by hand elsewhere — one h1 per
 * page, every control labelled, a visible focus ring. This runs the real axe
 * rule set instead, so a violation nobody thought to look for still fails.
 *
 * Violations are reported with the rule and the element, because "3 violations"
 * in a test failure tells whoever reads it nothing.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

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

async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();

  const readable = results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    elements: violation.nodes.map((node) => node.html.slice(0, 200)),
  }));

  expect(
    readable,
    `axe found ${readable.length} violation(s) on ${page.url()}`,
  ).toEqual([]);
}

test.describe("the pages the spec names", () => {
  test("home", async ({ page }) => {
    await page.goto("/");
    await audit(page);
  });

  test("category listing, with the filter panel", async ({ page }) => {
    await page.goto("/categories/snacks-groceries");
    await audit(page);
  });

  test("search results", async ({ page }) => {
    await page.goto("/search?q=candy");
    await audit(page);
  });

  test("product detail", async ({ page }) => {
    await page.goto("/products/seasonal-candy-variety-box");
    await audit(page);
  });

  test("cart, holding something", async ({ page }) => {
    await page.goto("/products/seasonal-candy-variety-box");
    const added = page.waitForResponse(
      (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add to cart" }).click();
    await added;

    await page.goto("/cart");
    await audit(page);
  });

  test("checkout", async ({ page }) => {
    await page.goto("/products/seasonal-candy-variety-box");
    const added = page.waitForResponse(
      (r) => r.url().includes("/api/cart") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add to cart" }).click();
    await added;

    await page.goto("/checkout");
    await audit(page);
  });
});

test.describe("the rest of the storefront", () => {
  test("sign in", async ({ page }) => {
    await page.goto("/login");
    await audit(page);
  });

  test("order tracking", async ({ page }) => {
    await page.goto("/orders/lookup");
    await audit(page);
  });

  test("account security, with the two-factor panel", async ({ page }) => {
    await signIn(page, "customer@example.com");
    await page.goto("/account/security");
    await audit(page);
  });

  /** An error state has to be as usable as a success state. */
  test("a search that found nothing", async ({ page }) => {
    await page.goto("/search?q=nothingmatchesthisatall");
    await audit(page);
  });
});

test.describe("admin", () => {
  test("the product list", async ({ page }) => {
    await signIn(page, "staff@example.com");
    await page.goto("/admin/products");
    await audit(page);
  });

  test("the order pipeline", async ({ page }) => {
    await signIn(page, "staff@example.com");
    await page.goto("/admin/orders");
    await audit(page);
  });

  test("settings", async ({ page }) => {
    await signIn(page, "admin@example.com");
    await page.goto("/admin/settings");
    await audit(page);
  });
});
