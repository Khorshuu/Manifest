import { expect, test, type Page } from "@playwright/test";

/**
 * Editing an existing product from the admin product page: the details form,
 * and the archive/restore pair that stands in for deletion.
 */

async function signIn(page: Page, email: string) {
  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
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

/**
 * Opens one section of the product editor.
 *
 * The editor is one page of sections (D-040) with a jump bar at the top;
 * pressing a section's button scrolls to it and unfolds it if folded. The
 * older names these tests use map onto the sections they now live in.
 */
const SECTIONS: Record<string, string> = {
  Description: "Product information",
  "Search listing": "Product information",
  Visibility: "Visibility & schedule",
};

async function openSection(page: Page, label: string) {
  await page
    .getByRole("navigation", { name: "Product sections" })
    .getByRole("button", { name: new RegExp(SECTIONS[label] ?? label) })
    .click();
}

/** Creates a product and lands on its admin page. */
async function createProduct(page: Page): Promise<string> {
  const title = `Edit Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();

  // Creating opens the setup wizard; this test wants the product page itself.
  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  await page.goto(page.url().split("?")[0]);

  return title;
}

test("staff edit a product and the change sticks", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Brand").fill("Northfield Supply");
  const sku = `NF-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("SKU").fill(sku);

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
  await expect(page.getByLabel("SKU")).toHaveValue(sku);
  // Status is no longer a field here: a new product is a draft until published.
  await expect(page.getByText("Not visible to customers.")).toBeVisible();
});

/**
 * The editor is a set of panels, each saving only the fields it owns. That is
 * the property the whole arrangement rests on: saving one panel must not
 * disturb another, which is exactly what the single form it replaced got
 * wrong whenever a section forgot to echo a field back.
 */
test("saving one section leaves the others alone", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Brand").fill("Northfield Supply");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await openSection(page, "Description");
  await page.getByRole("button", { name: "Add a feature" }).click();
  await page.getByLabel("Key features 1").fill("Sourced direct from the US");
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("What's included 1").fill("1 x carrying case");

  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/products/") &&
      r.request().method() === "PATCH",
  );
  // The description form within Product information has its own Save.
  await page
    .locator("#section-information form:has(#descriptionHtml)")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  expect((await saved).status()).toBe(200);

  await page.reload();

  // The brand survived a save that never mentioned it.
  await expect(page.getByLabel("Brand")).toHaveValue("Northfield Supply");

  await openSection(page, "Description");
  await expect(page.getByLabel("Key features 1")).toHaveValue(
    "Sourced direct from the US",
  );
  await expect(page.getByLabel("What's included 1")).toHaveValue(
    "1 x carrying case",
  );
});

test("a duplicate SKU is refused, with the clash named", async ({ page }) => {
  await signIn(page, "staff@example.com");

  const sku = `SHARED-${crypto.randomUUID().slice(0, 8)}`;

  await createProduct(page);
  await page.getByLabel("SKU").fill(sku);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await createProduct(page);
  await page.getByLabel("SKU").fill(sku);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText(/already belongs to/)).toBeVisible();
});

test("an empty title is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  await page.getByLabel("Product name").fill("");

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

  // Archiving lives on the Visibility tab.
  await openSection(page, "Visibility");
  await page.getByRole("button", { name: "Archive this product" }).click();
  await page.getByRole("button", { name: "Yes, archive it" }).click();

  await expect(page.getByText("Product archived.")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Off sale and hidden/)).toBeVisible();

  // Archived, not deleted: the listing still carries the row, under the
  // Archived filter (the default view hides archived products).
  await page.goto("/admin/products?status=archived");
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.goto(`${productUrl}?section=visibility`);
  await page.getByRole("button", { name: "Restore as a draft" }).click();
  await expect(page.getByText("Product restored as a draft.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Not visible to customers.")).toBeVisible();
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
