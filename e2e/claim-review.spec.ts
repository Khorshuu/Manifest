import { expect, test, type Page } from "@playwright/test";

/**
 * Reviewing many proposed values at once in Product Intelligence (D-128).
 *
 * The values are proposed the way a person proposes them — by handing over a
 * document — and decided on the screen: select, filter, select all, clear,
 * accept, reject. Nothing is decided by selecting; the decision is the button.
 */

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  const response = page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** A product with three values proposed from a document, and its intelligence page open. */
async function productWithProposals(page: Page) {
  const title = `Review Lamp ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Product name").fill(title);
  await page.getByRole("button", { name: "Save without SeoPulse" }).click();
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  const productUrl = page.url().split("?")[0];

  await page.goto(`${productUrl}/intelligence`);
  const pkbProductId = await page.locator("[data-knowledge-product]").getAttribute("data-knowledge-product");
  expect(pkbProductId).toBeTruthy();
  const provided = await page.request.post(`/api/admin/knowledge/products/${pkbProductId}/sources`, {
    data: {
      kind: "document",
      title: "Lamp data sheet",
      contentType: "text/plain",
      content: "Manufacturer: Lumen Works\nGeneration: Second\nMaterial: Brushed aluminium",
    },
  });
  expect(provided.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Proposed values" })).toBeVisible();
  return productUrl;
}

test("selecting decides nothing; Accept selected and Reject selected do, for what is selected and shown", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await productWithProposals(page);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Proposed values" }) });
  const rows = section.locator("li[data-claim]");
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // One checkbox at a time.
  await rows.first().getByRole("checkbox").check();
  await expect(section.getByText("1 selected").first()).toBeVisible();

  // Select all shown, then clear: nothing was decided.
  await section.getByLabel(/Select all shown/).check();
  await expect(section.getByText(`${count} selected`).first()).toBeVisible();
  await section.getByRole("button", { name: "Clear" }).click();
  await expect(section.getByText("0 selected").first()).toBeVisible();
  await page.reload();
  await expect(section.locator("li[data-claim]")).toHaveCount(count);

  // A filter with nothing in it offers nothing to select.
  await section.getByRole("button", { name: /In conflict/ }).click();
  await expect(section.getByText("Nothing waiting under this filter.")).toBeVisible();
  await expect(section.getByLabel(/Select all shown/)).toBeDisabled();
  await section.getByRole("button", { name: /All waiting/ }).click();

  // Accept one, reject the rest.
  await section.locator("li[data-claim]").first().getByRole("checkbox").check();
  await section.getByRole("button", { name: /Accept selected \(1\)/ }).click();
  await expect(page.getByText("Accepted 1 value.")).toBeVisible();
  await expect(section.locator("li[data-claim]")).toHaveCount(count - 1);

  await section.getByLabel(/Select all shown/).check();
  await section.getByRole("button", { name: "Reject selected" }).click();
  await expect(page.getByText(`Rejected ${count - 1} value`)).toBeVisible();
  await expect(section.getByText("Nothing is proposed.")).toBeVisible();
});

test("the review list and its action bar fit a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signIn(page, "staff@example.com");
  await productWithProposals(page);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Proposed values" }) });
  await expect(section.getByRole("button", { name: /Accept selected/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
