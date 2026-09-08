import { expect, test, type Page } from "@playwright/test";

/**
 * The variation engine as a staff member drives it: pick attributes, generate
 * the matrix, then disable a combination that should not be sold.
 */

/** Clicks generate and waits for the request itself, not just for text. */
async function generateAndWait(page: Page) {
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate variants" }).click();
  return (await response).json();
}

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

/** Creates a fresh product and returns the variants page URL for it. */
async function createProduct(page: Page): Promise<string> {
  // Random, not a timestamp: parallel workers can start in the same
  // millisecond and would otherwise create two products with one title.
  const title = `Variant Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL("**/admin/products");

  await page.getByRole("link", { name: title }).click();
  await page.getByRole("link", { name: "Manage variants" }).click();
  await expect(
    page.getByRole("heading", { name: "Variants", level: 1 }),
  ).toBeVisible();

  return page.url();
}

test("generating variants creates one per combination", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  // The seed defines Flavor (2 values) and Color (2 values).
  await page.getByRole("checkbox", { name: "Flavor" }).check();
  await page.getByRole("checkbox", { name: "Color" }).check();
  await expect(page.getByText("This would cover 4 combinations.")).toBeVisible();

  await page.getByLabel("Starting price (৳)").fill("1500");
  const body = await generateAndWait(page);
  expect(body.result.created).toBe(4);

  await expect(page.getByText(/4 created/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Variants \(4\)/ })).toBeVisible();
  // Price is entered in taka and stored in paisa; it must come back as taka.
  await expect(page.getByText("BDT 1,500").first()).toBeVisible();
});

test("generating twice does not duplicate variants", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByRole("checkbox", { name: "Flavor" }).check();

  const first = await generateAndWait(page);
  expect(first.result.created).toBe(2);

  const second = await generateAndWait(page);
  expect(second.result.created).toBe(0);
  expect(second.result.unchanged).toBe(2);

  await expect(page.getByText(/0 created, 2 left as they were/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Variants \(2\)/ })).toBeVisible();
});

test("an unwanted combination can be disabled without deleting it", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByRole("checkbox", { name: "Flavor" }).check();
  const generated = await generateAndWait(page);
  expect(generated.result.created).toBe(2);

  await expect(page.getByRole("heading", { name: /Variants \(2\)/ })).toBeVisible();
  await page.getByRole("checkbox", { name: /^Select / }).first().check();

  // Wait for the request, not just for text to appear: under parallel load the
  // refresh can land after the assertion would otherwise have run.
  const patched = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: /^Disable 1$/ }).click();
  expect((await patched).status()).toBe(200);

  await expect(page.getByText("1 variant updated.")).toBeVisible();
  await expect(page.getByText("Disabled")).toBeVisible();
  // Still two rows: disabling takes it off sale, it does not delete it.
  await expect(page.getByRole("heading", { name: /Variants \(2\)/ })).toBeVisible();
});

test("a customer cannot generate variants through the API", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/variants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: "00000000-0000-0000-0000-000000000000",
        attributeIds: [],
        priceBdt: 0,
      }),
    });
    return { status: response.status };
  });

  expect(result.status).toBe(403);
});

test("a customer cannot bulk-edit variants through the API", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/variants", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variantIds: ["00000000-0000-0000-0000-000000000000"],
        update: { priceBdt: 1 },
      }),
    });
    return { status: response.status };
  });

  expect(result.status).toBe(403);
});
