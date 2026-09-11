import { expect, test, type Page } from "@playwright/test";

/**
 * Variants as a staff member drives them (D-040): variant groups that belong
 * to this product only, combinations created as groups and values are added,
 * and a combination switched off without being deleted.
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

/** Creates a fresh product and opens its variants page. */
async function createProduct(page: Page): Promise<string> {
  // Random, not a timestamp: parallel workers can start in the same
  // millisecond and would otherwise create two products with one title.
  const title = `Variant Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();

  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  await page.goto(`${page.url().split("?")[0]}/variants`);
  await expect(page.getByRole("heading", { name: "Variants", level: 1 })).toBeVisible();
  return page.url();
}

/** Adds a variant group and waits for the combinations to be created. */
async function addGroup(page: Page, name: string, values: string) {
  await page.getByRole("button", { name: "+ Add variant group" }).click();
  await page.getByLabel("Group name").fill(name);
  await page.getByLabel("Values, separated by commas").fill(values);
  const generated = page.waitForResponse(
    (r) => r.url().includes("/api/admin/variants") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add group" }).click();
  const body = await (await generated).json();
  await expect(page.getByText(new RegExp(`“${name}” added`))).toBeVisible();
  return body;
}

test("a new product starts with no variant groups", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  // The seeded products have Flavor and Color; this one must not see them.
  await expect(page.getByText(/One version of this product/)).toBeVisible();
  await expect(page.getByText("Pumpkin Spice")).toHaveCount(0);
  await expect(page.getByText("Midnight Black")).toHaveCount(0);
});

test("adding groups creates one variant per combination, and no leftovers", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Starting price (৳)").or(page.getByLabel("Price (৳)")).first().fill("1500");
  const first = await addGroup(page, "Flavor", "Pumpkin Spice, Peppermint");
  expect(first.result.created).toBe(2);

  const second = await addGroup(page, "Size", "Small, Large");
  expect(second.result.created).toBe(4);
  // The two Flavor-only variants no longer fit and are removed.
  expect(second.result.removed).toBe(2);

  await expect(page.getByText("4 variants", { exact: true })).toBeVisible();
  // Price is entered in taka and stored in paisa; it must come back as taka.
  await expect(page.getByText("BDT 1,500").first()).toBeVisible();
});

test("an unwanted combination can be switched off without deleting it", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Starting price (৳)").or(page.getByLabel("Price (৳)")).first().fill("1500");
  await addGroup(page, "Flavor", "Pumpkin Spice, Peppermint");
  await expect(page.getByText("2 variants", { exact: true })).toBeVisible();

  // One row, not the "Select all variants" box in the header.
  await page.getByRole("checkbox", { name: /^Select (?!all)/ }).first().check();

  const patched = page.waitForResponse(
    (r) => r.url().includes("/api/admin/variants") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  expect((await patched).status()).toBe(200);

  await expect(page.getByText("1 variant turned off.")).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  // Still two: switching off takes it off sale, it does not delete it.
  await expect(page.getByText("2 variants", { exact: true })).toBeVisible();
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
