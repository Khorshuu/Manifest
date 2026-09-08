import { expect, test, type Page } from "@playwright/test";

/**
 * The product setup wizard from MASTER_PRODUCT_SPEC.md section 4, walked the
 * way a staff member walks it: basics, images, variations, pricing, SEO,
 * publish — ending with the product actually on the storefront.
 */

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

/** Creates a draft, which lands on the wizard, and returns its id. */
async function startWizard(page: Page): Promise<{ id: string; title: string }> {
  const title = `Wizard ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL((url) => url.pathname.includes("/wizard"));

  const id = new URL(page.url()).pathname.split("/")[3];
  return { id, title };
}

test("creating a product opens the wizard rather than a list", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  const { title } = await startWizard(page);

  await expect(
    page.getByRole("heading", { name: "Set up this product", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page).toHaveURL(/step=images/);
});

test("staff walk a product from draft to live", async ({ page }) => {
  // Six steps, an upload and a publish: slow by construction.
  test.slow();

  await signIn(page, "staff@example.com");
  const { id, title } = await startWizard(page);

  // Basics.
  await page.goto(`/admin/products/${id}/wizard?step=basics`);
  await page.getByLabel("Brand").fill("Northfield Supply");
  await page
    .getByLabel("Key points")
    .fill("Sourced direct from the US\nArrives sealed");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/step=images/);

  // Images.
  await page.getByLabel("Photograph", { exact: true }).setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await page.getByLabel("Describe the photograph").fill("The product itself");
  const uploaded = page.waitForResponse(
    (r) => r.url().includes("/images") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add photograph" }).click();
  expect((await uploaded).status()).toBe(201);

  await page.getByRole("link", { name: "Continue" }).click();
  await page.waitForURL(/step=variations/);

  // Variations: no attributes selected still produces one variant to sell.
  const generated = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Generate/ }).click();
  expect((await generated).status()).toBe(200);

  await page.goto(`/admin/products/${id}/wizard?step=pricing`);

  // Pricing: the step where a preorder gets its ceiling and its dates.
  await page.getByLabel("Price (BDT)").fill("1850");
  await page.getByLabel("Preorder capacity").fill("25");
  await page.getByLabel("Preorder closes").fill("2027-01-31");
  await page.getByLabel("Arrives from").fill("2027-03-01");
  await page.getByLabel("Arrives to").fill("2027-03-20");

  const savedVariant = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants/") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save this variant" }).click();
  expect((await savedVariant).status()).toBe(200);
  await expect(page.getByText("Saved.")).toBeVisible();

  // SEO.
  await page.goto(`/admin/products/${id}/wizard?step=seo`);
  await page
    .getByLabel("Meta description")
    .fill("Preorder this from the US, delivered in Bangladesh.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/step=publish/);

  // Publish: the checklist is satisfied, so the button is live.
  const publishButton = page.getByRole("button", { name: "Publish" });
  await expect(publishButton).toBeEnabled();

  const published = page.waitForResponse(
    (r) => r.url().includes("/publish") && r.request().method() === "POST",
  );
  await publishButton.click();
  expect((await published).status()).toBe(200);
  await expect(page.getByText("Published. It is live on the storefront now.")).toBeVisible();

  // And it really is on the storefront, to a signed-out visitor.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();
});

test("an unfinished product cannot be published", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const { id } = await startWizard(page);

  await page.goto(`/admin/products/${id}/wizard?step=publish`);

  // The button is off, and the checklist says exactly what is missing.
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(page.getByText("It has at least one photograph")).toBeVisible();
  await expect(page.getByText("It has something to buy")).toBeVisible();

  // The server refuses it too, so the disabled button is a courtesy.
  const result = await page.evaluate(async (productId: string) => {
    const response = await fetch(`/api/admin/products/${productId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "preorder_open" }),
    });
    return { status: response.status, body: await response.json() };
  }, id);

  expect(result.status).toBe(409);
  expect(result.body.error).toMatch(/not ready to publish/i);
});

test("every step is reachable in any order", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const { id } = await startWizard(page);

  // Jumping straight to the last step is allowed: coming back to fix one field
  // is the common case.
  await page.goto(`/admin/products/${id}/wizard?step=publish`);
  await expect(page.getByRole("heading", { name: "Before it goes live" })).toBeVisible();

  await page.getByRole("link", { name: "1 Basic info" }).click();
  await page.waitForURL(/step=basics/);
  await expect(page.getByLabel("Title")).toBeVisible();
});

test("an unknown step falls back to the first one", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const { id } = await startWizard(page);

  await page.goto(`/admin/products/${id}/wizard?step=nonsense`);
  await expect(page.getByLabel("Title")).toBeVisible();
  await expect(page.getByText("Step 1 of 6")).toBeVisible();
});

test("a customer cannot reach the wizard or publish", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const { id } = await startWizard(page);

  await signIn(page, "customer@example.com");

  await page.goto(`/admin/products/${id}/wizard?step=basics`);
  await expect(page).not.toHaveURL(/wizard/);

  const status = await page.evaluate(async (productId: string) => {
    const response = await fetch(`/api/admin/products/${productId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "preorder_open" }),
    });
    return response.status;
  }, id);

  expect(status).toBe(403);
});
