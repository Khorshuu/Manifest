import { expect, test, type Page } from "@playwright/test";

/**
 * The product and category workflow as a staff member actually performs it,
 * against the seeded development database.
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

test("staff sees the seeded catalog with live variant counts", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products");

  await expect(
    page.getByRole("heading", { name: "Products", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Seasonal Candy Variety Box", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Studio Reference Headphones", exact: true }),
  ).toBeVisible();
});

/** The category tree, as whichever of its two shapes is on screen. */
function categoryTree(page: Page) {
  return page
    .getByRole("list", { name: "Categories" })
    .or(page.getByRole("main").getByRole("table"))
    .filter({ visible: true })
    .first();
}

test("the category tree shows its nesting", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/categories");

  // Scoped to the tree: the same names also appear in the parent select.
  // The tree is a list of cards on a phone and a table from `md` up.
  const tree = categoryTree(page);
  await expect(tree.getByText("Snacks & Groceries", { exact: true })).toBeVisible();
  await expect(tree.getByText("Candy & Chocolate", { exact: true })).toBeVisible();
  await expect(tree.getByText("Seasonal & Limited Edition", { exact: true })).toBeVisible();
});

test("a staff member adds a category, and its slug follows the name", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/categories");

  const name = `Test Category ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name").fill(name);

  // The slug field fills itself from the name.
  await expect(page.getByLabel("Slug")).toHaveValue(/^test-category-[a-f0-9]+$/);

  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/categories") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add category" }).click();
  expect((await response).status()).toBe(201);

  await expect(
    categoryTree(page).getByText(name, { exact: true }),
  ).toBeVisible();
});

test("a staff member adds a product and it appears in the list", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  const title = `Test Product ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Brand").fill("Test Brand");
  await page.getByLabel("Status").selectOption("preorder_open");
  await page.getByRole("button", { name: "Save product" }).click();

  // Creating drops straight into the setup wizard.
  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));

  await page.goto("/admin/products");
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
});

/**
 * The server-side rule from MASTER_PRODUCT_SPEC.md: a customer cannot create a
 * listing under any circumstance. Posting straight at the API skips the UI,
 * which is the point — hiding a button is not access control.
 */
test("a customer posting directly to the product API is refused", async ({
  page,
}) => {
  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Smuggled listing",
        categoryId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    return { status: response.status, body: await response.json() };
  });

  expect(result.status).toBe(403);
  expect(result.body.error).toMatch(/staff and administrators/i);
});

test("an anonymous visitor posting to the product API is refused", async ({
  page,
}) => {
  await page.goto("/login");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/admin/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Smuggled listing",
        categoryId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    return { status: response.status };
  });

  expect(result.status).toBe(401);
});

test("a customer cannot reach the category admin page", async ({ page }) => {
  await signIn(page, "customer@example.com");
  await page.goto("/admin/categories");
  await expect(page).toHaveURL("/");
});
