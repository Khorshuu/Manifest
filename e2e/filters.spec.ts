import { expect, test } from "@playwright/test";

/**
 * Faceted filtering and autosuggest in the browser.
 *
 * The filter panel is an ordinary GET form on purpose: the URL carries the
 * state, so these tests can navigate straight to a filtered listing exactly as
 * a shared link would.
 */

test("the filter panel narrows the listing and the count agrees", async ({
  page,
}) => {
  await page.goto("/categories/snacks-groceries");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();

  const before = Number(
    (await page.getByText(/\d+ products?$/).first().innerText()).match(/\d+/)![0],
  );
  expect(before).toBeGreaterThan(0);

  // A price ceiling nothing can meet empties the listing, and the count on the
  // page has to agree with what is actually shown.
  await page.getByLabel("To (BDT)").fill("1");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/max=1/);

  await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
  await expect(page.getByText(/^0 products$/)).toBeVisible();

  // Clearing brings them all back.
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.getByText(new RegExp(`^${before} products?$`))).toBeVisible();
});

test("filtering by an attribute value", async ({ page }) => {
  await page.goto("/search");

  // The seeded catalog varies by Flavor and Color.
  const flavor = page.getByRole("group", { name: "Flavor" });
  await expect(flavor).toBeVisible();

  const firstValue = flavor.getByRole("checkbox").first();
  const label = await flavor.locator("label").first().innerText();

  await firstValue.check();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/value=/);

  // The choice survives the round trip, so the panel is not lying about state.
  await expect(
    page.getByRole("group", { name: "Flavor" }).getByRole("checkbox").first(),
  ).toBeChecked();
  expect(label).toBeTruthy();
});

test("in-stock only excludes the preorder catalog", async ({ page }) => {
  // Everything seeded is a preorder, so this filter should empty the listing
  // rather than quietly ignore itself.
  await page.goto("/search?fulfillment=in_stock");

  await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
});

test("filters survive pagination and sorting", async ({ page }) => {
  await page.goto("/categories/snacks-groceries?max=100000&sort=price_asc");

  await expect(page.getByLabel("To (BDT)")).toHaveValue("100000");

  // Sorting keeps the filter in the URL rather than dropping it.
  await page.getByLabel("Sort").selectOption("price_desc");
  await page.waitForURL(/sort=price_desc/);
  await expect(page).toHaveURL(/max=100000/);
});

test("a filtered listing can be linked", async ({ page }) => {
  const url = "/search?available=1&fulfillment=preorder&sort=price_asc";
  await page.goto(url);

  await expect(
    page.getByRole("checkbox", { name: "Only what can be bought now" }),
  ).toBeChecked();
  await expect(page.getByRole("radio", { name: "Preorder only" })).toBeChecked();
});

test("autosuggest offers products as you type", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search products").fill("stud");

  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox).toBeVisible();
  await expect(
    listbox.getByRole("option", { name: /Studio Reference Headphones/ }),
  ).toBeVisible();

  await listbox.getByRole("option").first().click();
  await page.waitForURL(/\/products\//);
});

test("autosuggest is reachable by keyboard", async ({ page }) => {
  await page.goto("/");

  const input = page.getByLabel("Search products");
  await input.fill("candy");
  await expect(
    page.getByRole("listbox", { name: "Search suggestions" }),
  ).toBeVisible();

  await input.press("ArrowDown");
  await input.press("Enter");

  await page.waitForURL((url) => url.pathname !== "/");
});

test("one character suggests nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search products").fill("s");

  await expect(
    page.getByRole("listbox", { name: "Search suggestions" }),
  ).toHaveCount(0);

  // And the endpoint itself refuses to answer a single character.
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/search/suggest?q=s");
    return response.json();
  });

  expect(body.suggestions).toEqual([]);
});

test("autosuggest never leaks a draft product", async ({ page }) => {
  await page.goto("/");

  const title = `Hidden Drop ${crypto.randomUUID().slice(0, 8)}`;

  // Create a draft as staff, then ask as a signed-out visitor.
  await page.goto("/login");
  await page.getByLabel("Email").fill("staff@example.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL((url) => url.pathname.includes("/wizard"));

  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const body = await page.evaluate(async (term: string) => {
    const response = await fetch(
      `/api/search/suggest?q=${encodeURIComponent(term)}`,
    );
    return response.json();
  }, title.slice(0, 10));

  expect(body.suggestions).toEqual([]);
});
