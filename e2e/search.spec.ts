import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The search experience in a browser: the header box, the results page, the
 * correction, the empty page, and the staff controls that change what search
 * finds. Seeded catalogue only — "headphones", "candy", "coffee" — so every
 * assertion is about data the seed guarantees.
 */

/**
 * The editor is one page of sections (D-040); search fields sit under
 * SEO & search. The jump bar scrolls there.
 */
async function openSearchListing(page: Page) {
  await page
    .getByRole("navigation", { name: "Product sections" })
    .getByRole("button", { name: /SEO & search/ })
    .click();
  await expect(page.locator("#seoMetaTitle")).toBeVisible();
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("the header box suggests searches and products, and the keyboard drives it", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("Search products");
  await input.fill("headph");

  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox).toBeVisible();
  await expect(
    listbox
      .getByRole("group", { name: "Products" })
      .getByRole("option", { name: /Studio Reference Headphones/ }),
  ).toBeVisible();

  // Escape closes. On a wide screen the field keeps focus and a second
  // Escape clears it; on a phone the first one also leaves the full-screen
  // search, which is what Cancel does.
  await input.press("Escape");
  await expect(listbox).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    await input.press("Escape");
    await expect(input).toHaveValue("");
  }

  await input.fill("headph");
  await expect(listbox).toBeVisible();
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", /.+/);
  await input.press("Enter");
  await page.waitForURL((url) => url.pathname !== "/");
});

/** The queries the header box sent for suggestions, in order. */
function recordSuggestQueries(page: Page): string[] {
  const queries: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/search/suggest") {
      queries.push(url.searchParams.get("q") ?? "");
    }
  });
  return queries;
}

/**
 * The home page, once its scripts have run. Keys pressed before the header box
 * hydrates are typed into markup React then resets to its own empty state, so
 * a test that types one key at a time straight after `goto` loses them on a
 * slow `next dev` compile and fails on an empty field.
 */
async function openHome(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

/*
 * The exact timing (250 ms, reset on every keystroke) is pinned with fake
 * timers in tests/search-autocomplete.test.ts. Here: in a real browser,
 * typing does not ask once per keystroke, and a submitted search does not
 * wait for suggestions or fetch any for the list it closes.
 */
test("the header box asks for suggestions when typing pauses, not per keystroke", async ({
  page,
}) => {
  await openHome(page);
  const queries = recordSuggestQueries(page);
  const input = page.getByLabel("Search products");

  await input.pressSequentially("headph", { delay: 30 });
  await expect(input).toHaveValue("headph");

  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(
    listbox.getByRole("option", { name: /Studio Reference Headphones/ }),
  ).toBeVisible();

  // Five keystrokes were long enough to ask on.
  expect(queries.length).toBeLessThan(5);
  expect(queries.at(-1)).toBe("headph");
  expect(queries.some((query) => query.trim().length < 2)).toBe(false);
});

test("Enter searches at once, without fetching suggestions first", async ({
  page,
}) => {
  await openHome(page);
  const queries = recordSuggestQueries(page);
  const input = page.getByLabel("Search products");

  await input.pressSequentially("coffee", { delay: 20 });
  await input.press("Enter");
  await page.waitForURL(/\/search\?q=coffee/);

  // Longer than the debounce: a timer that survived the submit would fire.
  await page.waitForTimeout(600);
  expect(queries).not.toContain("coffee");
});

test("the Search button searches at once, without fetching suggestions first", async ({
  page,
}) => {
  await openHome(page);
  const queries = recordSuggestQueries(page);
  const input = page.getByLabel("Search products");

  await input.pressSequentially("candy", { delay: 20 });
  await page
    .getByRole("search", { name: "Search the catalogue" })
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await page.waitForURL(/\/search\?q=candy/);

  await page.waitForTimeout(600);
  expect(queries).not.toContain("candy");
});

test("a submitted search is remembered as a recent search", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Search products");
  await input.fill("coffee");
  await input.press("Enter");
  await page.waitForURL(/\/search\?q=coffee/);

  await expect(input).toHaveValue("coffee");
  await input.fill("");
  await input.focus();

  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox.getByRole("option", { name: "coffee" })).toBeVisible();

  await page.getByRole("button", { name: "Clear recent searches" }).click();
  await expect(listbox).toHaveCount(0);
});

test("the results page counts, sorts, and keeps its state in the address", async ({
  page,
}) => {
  await page.goto("/search?q=headphones");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("headphones");
  await expect(page.getByText(/\d+ results?\./).first()).toBeVisible();

  await page.getByLabel("Sort").selectOption("price_desc");
  await page.waitForURL(/sort=price_desc/);
  await expect(page).toHaveURL(/q=headphones/);

  await page.reload();
  await expect(page.getByLabel("Sort")).toHaveValue("price_desc");
});

test("a misspelling is corrected when nothing matched as typed", async ({ page }) => {
  await page.goto("/search?q=headphnes");

  await expect(page.getByText(/No results for “headphnes”/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Studio Reference Headphones/ }).first(),
  ).toBeVisible();

  await page.getByRole("link", { name: /Search instead for/ }).click();
  await page.waitForURL(/spell=0/);
  await expect(page.getByText(/Nothing matched/)).toBeVisible();
});

test("a search that finds nothing offers ways forward and no unrelated products", async ({
  page,
}) => {
  await page.goto("/search?q=zzqxv%20headphones");

  await expect(page.getByText(/Nothing matched/)).toBeVisible();
  await expect(page.getByText("Related searches")).toBeVisible();
  await expect(page.getByRole("link", { name: /^headphones/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
});

test("a filter chip removes exactly its filter", async ({ page }) => {
  await page.goto("/search?q=candy&brand=Hometown%20Confectionery");

  const chip = page.getByRole("link", { name: /Hometown Confectionery.*remove/ });
  await expect(chip).toBeVisible();
  await chip.click();

  await page.waitForURL((url) => !url.search.includes("brand="));
  await expect(page).toHaveURL(/q=candy/);
});

test("search pages are not indexed but are followed", async ({ page }) => {
  await page.goto("/search?q=candy");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    "content",
    /noindex/,
  );
});

test("the results page passes the accessibility audit with filters on", async ({
  page,
}) => {
  await page.goto("/search?q=candy&available=1&sort=price_asc");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test("staff can hide a product from search without unpublishing it", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products?q=Maple%20Pecan");
  await page
    .getByRole("link", { name: "Maple Pecan Coffee Beans", exact: true })
    .click();
  await openSearchListing(page);

  const toggle = page.getByLabel("Show this product in search results and suggestions");
  await toggle.uncheck();
  await page
    .locator("#section-seo form:has(#seoMetaTitle)")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Saved.").first()).toBeVisible();

  await page.goto("/search?q=maple%20pecan");
  await expect(page.getByText(/Nothing matched/)).toBeVisible();
  await page.goto("/products/maple-pecan-coffee-beans");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Maple Pecan");

  // Put it back for everyone else.
  await page.goBack();
  await page.goto("/admin/products?q=Maple%20Pecan");
  await page
    .getByRole("link", { name: "Maple Pecan Coffee Beans", exact: true })
    .click();
  await openSearchListing(page);
  await page.getByLabel("Show this product in search results and suggestions").check();
  await page
    .locator("#section-seo form:has(#seoMetaTitle)")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
});

test("staff can add a synonym and search follows it", async ({ page }) => {
  const word = `zq${crypto.randomUUID().slice(0, 6)}`;
  await signIn(page, "staff@example.com");
  await page.goto("/admin/search");

  /*
   * Retried, because a dev server under a full run hydrates late: a press
   * that lands first submits the plain form with no handler attached. The
   * entry is only written once, so the retry cannot duplicate it.
   */
  await expect(async () => {
    await page.getByLabel("When a shopper searches for").fill(word);
    await page.getByLabel("Also find").fill("skillet");
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/search/synonyms") &&
        response.request().method() === "POST",
      { timeout: 5_000 },
    );
    await page.getByRole("button", { name: "Add synonym" }).click();
    expect((await saved).status()).toBe(201);
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(`“${word}” added.`)).toBeVisible();

  await page.goto(`/search?q=${word}`);
  await expect(
    page.getByRole("link", { name: /Cast Iron Skillet/ }).first(),
  ).toBeVisible();
});

test.describe("on a phone", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) >= 768, "phone layout only");

  test("the search opens as a small card and closes again", async ({ page }) => {
    await page.goto("/");
    // On a phone the search is an icon in the header; pressing it opens a
    // compact search card at the top of the screen with the field focused —
    // not a full-screen page.
    await page.getByRole("button", { name: "Open search" }).click();
    const close = page.getByRole("button", { name: "Close search" });
    await expect(close).toBeVisible();
    await expect(page.getByLabel("Search products")).toBeFocused();

    const card = await page.evaluate(() => {
      const input = document.getElementById("site-search");
      const box = input?.closest("[class*='rounded-card']")?.getBoundingClientRect();
      return box ? { height: box.height, viewport: window.innerHeight } : null;
    });
    expect(card).not.toBeNull();
    expect(card!.height).toBeLessThan(card!.viewport / 2);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await close.click();
    await expect(page.getByRole("button", { name: "Close search" })).toHaveCount(0);
  });

  test("filters and sort sit side by side above the results", async ({ page }) => {
    await page.goto("/search?q=candy");
    await expect(page.locator('label[for="filter-drawer"]').first()).toBeVisible();
    await expect(page.getByLabel("Sort")).toBeVisible();
  });
});
