import { expect, test, type Page } from "@playwright/test";

/**
 * Faceted filtering and autosuggest in the browser.
 *
 * The filter panel is an ordinary GET form on purpose: the URL carries the
 * state, so these tests can navigate straight to a filtered listing exactly as
 * a shared link would.
 *
 * Below `lg` the panel is a bottom sheet that has to be opened first, so every
 * test that touches a control inside it calls `openFilters`. That is the real
 * behaviour on a phone rather than a test convenience: a closed sheet is
 * `invisible`, so its inputs are out of reach of a pointer and a keyboard
 * alike.
 */

async function openFilters(page: Page) {
  /*
   * Located by what it controls rather than by its words: the trigger reads
   * "Filters on" once something is filtering, so matching on text alone
   * silently stopped opening the sheet exactly when a test had filters
   * applied — which is every test that needs it.
   *
   * It only exists below `lg`; on a wide screen the panel is part of the page
   * and there is nothing to open.
   */
  /*
   * Wait for the document to settle first.
   *
   * `waitForURL` resolves as soon as the address matches, which can be before
   * the new document has replaced the old one. Opening the sheet at that
   * moment opens it on the page that is about to be thrown away, and the
   * assertion that follows then runs against a closed one.
   */
  await page.waitForLoadState("networkidle");

  const trigger = page.locator('label[for="filter-drawer"]').first();
  if (!(await trigger.isVisible())) return;

  /*
   * Retried, because this usually runs straight after a navigation: a click
   * that lands while the new document is still being swapped in toggles a
   * checkbox that is about to be replaced, and the sheet stays shut.
   */
  await expect(async () => {
    if (!(await page.locator("#filter-drawer").isChecked())) {
      await trigger.click();
    }
    await expect(page.getByText(/^Show [\d,]+ results?$/)).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 15_000 });
}

test("the filter panel narrows the listing and the count agrees", async ({
  page,
}) => {
  await page.goto("/categories/snacks-groceries");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();

  /*
   * The count is read from the filter panel's own "N matches" rather than from
   * the prose under the heading. The panel's figure is the one that has to
   * agree with the listing — it comes from `countProducts`, which the panel and
   * the grid both build from `buildProductWhere` — and it does not move when
   * the heading copy is rewritten, which is exactly what broke this test once.
   */
  const matches = async () => {
    await page.waitForLoadState("networkidle");
    return Number(
      await page
        .locator("[data-result-count]")
        .first()
        .getAttribute("data-result-count"),
    );
  };

  const before = await matches();
  expect(before).toBeGreaterThan(0);

  // A price ceiling nothing can meet empties the listing, and the count on the
  // page has to agree with what is actually shown.
  // Filters apply as they are chosen; the price waits for typing to pause.
  await openFilters(page);
  await page.getByLabel("Highest price (BDT)").fill("1");
  await page.waitForURL(/max=1/);

  await expect(page.getByText("Nothing matches those filters")).toBeVisible();
  expect(await matches()).toBe(0);

  // Clearing brings them all back. Exact, because the chips above the listing
  // carry their own "Clear all" — the panel's own control is the one under
  // test here.
  // The panel's own "Clear all" is an ordinary link; followed directly so the
  // phone's open sheet cannot get in the way of the click.
  const clear = await page
    .getByRole("link", { name: "Clear all", exact: true })
    .first()
    .getAttribute("href");
  await page.goto(clear!);
  await page.waitForURL((url) => !url.search.includes("max=1"));
  expect(await matches()).toBe(before);
});

test("filtering by an attribute value", async ({ page }) => {
  await page.goto("/search");
  await openFilters(page);

  // The seeded catalog varies by Flavor and Color.
  const flavor = page.getByRole("group", { name: "Flavor" });
  await expect(flavor).toBeVisible();

  const firstValue = flavor.getByRole("checkbox").first();
  const label = await flavor.locator("label").first().innerText();

  // No Apply button: ticking a value applies it.
  await firstValue.check();
  // Attribute filters travel under the attribute's own name.
  await page.waitForURL(/flavor=/);

  // The choice survives the round trip, so the panel is not lying about state.
  await openFilters(page);
  await expect(
    page.getByRole("group", { name: "Flavor" }).getByRole("checkbox").first(),
  ).toBeChecked();
  expect(label).toBeTruthy();
});

test("in-stock only excludes the preorder catalog", async ({ page }) => {
  // Everything seeded is a preorder, so this filter should empty the listing
  // rather than quietly ignore itself.
  await page.goto("/search?fulfillment=in_stock");

  await expect(page.getByText("Nothing matches those filters")).toBeVisible();
});

test("filters survive pagination and sorting", async ({ page }) => {
  await page.goto("/categories/snacks-groceries?max=100000&sort=price_asc");
  await openFilters(page);

  await expect(page.getByLabel("Highest price (BDT)")).toHaveValue("100000");

  // Sorting keeps the filter in the URL rather than dropping it.
  await page.getByLabel("Sort").selectOption("price_desc");
  await page.waitForURL(/sort=price_desc/);
  await expect(page).toHaveURL(/max=100000/);
});

test("a filtered listing can be linked", async ({ page }) => {
  const url = "/search?available=1&fulfillment=preorder&sort=price_asc";
  await page.goto(url);
  await openFilters(page);

  await expect(
    page.getByRole("checkbox", { name: "Can be bought now" }),
  ).toBeChecked();
  await expect(page.getByRole("radio", { name: "Preorder only" })).toBeChecked();
});

test("autosuggest offers products as you type", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search products").fill("stud");

  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox).toBeVisible();
  // The name appears twice — as a completed search and as the product — so
  // the product is found in its own group. Choosing it opens the product.
  const product = listbox
    .getByRole("group", { name: "Products" })
    .getByRole("option", { name: /Studio Reference Headphones/ });
  await expect(product).toBeVisible();
  await product.click();
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
  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));

  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const body = await page.evaluate(async (term: string) => {
    const response = await fetch(
      `/api/search/suggest?q=${encodeURIComponent(term)}`,
    );
    return response.json();
  }, title.slice(0, 10));

  expect(body.suggestions).toEqual([]);
});
