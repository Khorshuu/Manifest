import { expect, test, type Page } from "@playwright/test";

/**
 * Editing an existing product from the admin product page: the details form,
 * and the archive/restore pair that stands in for deletion.
 */

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

/** Creates a product and lands on its admin page. */
async function createProduct(page: Page): Promise<string> {
  const title = `Edit Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL("**/admin/products");

  await page.getByRole("link", { name: title }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/products/"));

  return title;
}

test("staff edit a product and the change sticks", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Brand").fill("Northfield Supply");
  await page
    .getByLabel("Key points")
    .fill("Sourced direct from the US\nArrives sealed");
  await page.getByLabel("Status").selectOption("preorder_open");

  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/products/") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).status()).toBe(200);

  await expect(page.getByText("Saved.")).toBeVisible();

  // Reload rather than trusting the optimistic message.
  await page.reload();
  await expect(page.getByLabel("Brand")).toHaveValue("Northfield Supply");
  await expect(page.getByLabel("Status")).toHaveValue("preorder_open");
  await expect(page.getByLabel("Key points")).toHaveValue(
    "Sourced direct from the US\nArrives sealed",
  );
});

test("an empty title is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  // Exact: the search-listing fieldset also has a "Meta title".
  await page.getByLabel("Title", { exact: true }).fill("");

  const refused = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/products/") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await refused).status()).toBe(400);

  await expect(page.getByText("Enter a title.")).toBeVisible();
});

/** Archiving asks first, then takes the product off sale without deleting it. */
test("staff archive a product and restore it as a draft", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const title = await createProduct(page);
  const productUrl = page.url();

  await page.getByRole("button", { name: "Archive this product" }).click();
  await page.getByRole("button", { name: "Yes, archive it" }).click();

  await expect(page.getByText("Product archived.")).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveValue("archived");

  // Archived, not deleted: the listing still carries the row.
  await page.goto("/admin/products");
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.goto(productUrl);
  await page.getByRole("button", { name: "Restore as a draft" }).click();
  await expect(page.getByText("Product restored as a draft.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Status")).toHaveValue("draft");
});

test("a customer cannot edit a product", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);
  const productId = page.url().split("/").pop()!;

  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async (id: string) => {
    const patch = await fetch(`/api/admin/products/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Hijacked",
        categoryId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    const archive = await fetch(`/api/admin/products/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    return { patch: patch.status, archive: archive.status };
  }, productId);

  // The category id is a well-formed uuid, so this is authorization, not shape.
  expect(result.patch).toBe(403);
  expect(result.archive).toBe(403);
});

test("a malformed product id is refused rather than crashing", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/products/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    return response.status;
  });

  expect(status).toBe(400);
});
