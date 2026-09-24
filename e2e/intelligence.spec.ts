import { expect, test, type Page } from "@playwright/test";

/**
 * The Intelligence workspace in a browser.
 *
 * Five admin destinations became one with seven tabs, so what is asserted here
 * is the behaviour that consolidation can quietly break: the address bar
 * carrying the selected tab, a refresh keeping it, a role only being offered
 * the tabs it may open, the old addresses still answering, and a phone not
 * scrolling sideways.
 */

async function signIn(page: Page, email: string, password = "password123") {
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const tabs = () => ({ name: "Intelligence sections" }) as const;

test("the main navigation offers Intelligence and not the five screens it replaced", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin");

  const sections = page.getByRole("navigation", { name: "Admin sections" }).first();
  await expect(sections.getByRole("link", { name: "Intelligence", exact: true })).toBeVisible();

  for (const gone of ["Search", "SEO Pulse", "SEO health", "Search performance", "Knowledge"]) {
    await expect(sections.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
  }

  // The destinations that are deliberately independent are untouched.
  for (const kept of ["Orders", "Products", "Background work", "Analytics", "Settings"]) {
    await expect(sections.getByRole("link", { name: kept, exact: true })).toBeVisible();
  }
});

test("every tab opens, and the address bar says which one", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/intelligence");

  await expect(page.getByRole("heading", { name: "Intelligence", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What needs your attention" })).toBeVisible();

  const nav = page.getByRole("navigation", tabs());
  const expected: [string, string, string][] = [
    ["SeoPulse", "/admin/intelligence/seo-pulse", "SeoPulse"],
    ["Product Knowledge", "/admin/intelligence/knowledge", "Product Knowledge"],
    ["SearchPulse", "/admin/intelligence/searchpulse", "SearchPulse"],
    ["SEO Health", "/admin/intelligence/seo-health", "SEO Health"],
    ["Search Console", "/admin/intelligence/search-console", "Search Console"],
    ["Sources & Policies", "/admin/intelligence/sources", "Sources & Policies"],
  ];

  for (const [label, path, heading] of expected) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  // Back and forward move through the tabs, because they are real routes.
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/intelligence\/search-console$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/intelligence\/sources$/);
});

test("a refresh keeps the selected tab and its filter", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/intelligence/seo-health?severity=required");

  await expect(page.getByRole("heading", { name: "Findings — Needed" })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/severity=required$/);
  await expect(page.getByRole("heading", { name: "Findings — Needed" })).toBeVisible();
  await expect(
    page.getByRole("navigation", tabs()).getByRole("link", { name: "SEO Health", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("an overview card takes you to the tab that lists what it counted", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/intelligence");

  await page.getByRole("link", { name: /Needs review/ }).first().click();
  await expect(page).toHaveURL(/\/admin\/intelligence\/seo-pulse\?filter=needs-review$/);
  await expect(page.getByRole("heading", { name: "Preparation — Needs review" })).toBeVisible();

  await page.goto("/admin/intelligence");
  await page.getByRole("link", { name: /Not identified/ }).first().click();
  await expect(page).toHaveURL(/\/admin\/intelligence\/knowledge\?focus=unresolved$/);
  await expect(page.getByRole("heading", { name: "Unresolved identities" })).toBeVisible();
});

test("a deep link with an unknown filter opens the tab unfiltered rather than failing", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/intelligence/seo-pulse?filter=nonsense");
  await expect(page.getByRole("heading", { name: "Preparation runs waiting on a person" })).toBeVisible();
});

test("Search Console explains itself when it is not connected", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/intelligence/search-console");

  // The test environment has no Search Console credentials, so this is the
  // unconfigured state — a sentence and an explanation, not an error screen.
  await expect(page.getByRole("heading", { name: "Search Console not connected" })).toBeVisible();
  await expect(page.getByText(/works without it|Connecting it would add/)).toBeVisible();
  await expect(page.getByText("NOT_CONFIGURED")).toHaveCount(0);

  // The rest of the workspace is still usable from here.
  await page
    .getByRole("navigation", tabs())
    .getByRole("link", { name: "SEO Health", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "SEO Health", exact: true }).first()).toBeVisible();
});

test("the old addresses still answer, and say where the screen now lives", async ({ page }) => {
  await signIn(page, "admin@example.com");

  for (const [path, tab] of [
    ["/admin/seo-pulse", "SeoPulse"],
    ["/admin/knowledge", "Product Knowledge"],
    ["/admin/search", "SearchPulse"],
    ["/admin/seo-health", "SEO Health"],
    ["/admin/seo-performance", "Search Console"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText(`This screen is now the ${tab} tab of`)).toBeVisible();
  }
});

test("a bookmarked search period still works at the old address", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/search?days=90");
  await expect(page).toHaveURL(/\/admin\/search\?days=90$/);
  await expect(page.getByText(/last 90 days/).first()).toBeVisible();
});

test("product intelligence and background work remain their own destinations", async ({ page }) => {
  await signIn(page, "admin@example.com");

  await page.goto("/admin/jobs");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/jobs$/);

  await page.goto("/admin/products");
  // The "New product" link lives at /admin/products/new, so match an id.
  const href = await page
    .locator('a[href^="/admin/products/"]:not([href$="/new"])')
    .first()
    .getAttribute("href");
  expect(href).toMatch(/^\/admin\/products\/[0-9a-f-]+$/);

  // The product-specific drill-down is a different thing from the
  // catalogue-wide workspace, and it is still there.
  await page.goto(`${href}/intelligence`);
  await expect(page.getByText("Product intelligence")).toBeVisible();
});

test.describe("a role without the catalogue permission", () => {
  const email = `marketing-${Date.now()}@example.com`;
  const password = "a-long-enough-password";

  test("is offered only the tabs it may open, and is refused the rest", async ({ page }) => {
    await signIn(page, "admin@example.com");
    const created = await page.evaluate(
      async ({ email, password }) => {
        const response = await fetch("/api/admin/staff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, role: "marketing" }),
        });
        return response.status;
      },
      { email, password },
    );
    expect(created).toBe(200);

    await signIn(page, email, password);
    await page.goto("/admin/intelligence");

    const nav = page.getByRole("navigation", tabs());
    await expect(nav.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "SearchPulse", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Search Console", exact: true })).toBeVisible();

    // No "Access denied" tab: a tab this role cannot open is simply absent.
    for (const hidden of ["SeoPulse", "Product Knowledge", "SEO Health", "Sources & Policies"]) {
      await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
    }

    // The overview shows only the sections its permissions cover.
    await expect(page.getByRole("heading", { name: "SearchPulse" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Product knowledge" })).toHaveCount(0);

    // Typing the address of a tab it may not open is refused by the server.
    await page.goto("/admin/intelligence/knowledge");
    await expect(page).toHaveURL(/\/admin(\?denied=1)?$/);

    // And the API behind that tab refuses it too, not only the page.
    const refused = await page.evaluate(async () => {
      const response = await fetch("/api/admin/knowledge/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "decide", entryId: crypto.randomUUID(), decision: "approved" }),
      });
      return response.status;
    });
    expect(refused).toBe(403);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test("the tab bar is reachable and the page does not scroll sideways", async ({ page }) => {
    await signIn(page, "admin@example.com");

    for (const path of [
      "/admin/intelligence",
      "/admin/intelligence/seo-pulse",
      "/admin/intelligence/knowledge",
      "/admin/intelligence/searchpulse",
      "/admin/intelligence/seo-health",
      "/admin/intelligence/search-console",
      "/admin/intelligence/sources",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }

    // The tab row scrolls inside itself, so every tab can still be reached.
    const nav = page.getByRole("navigation", tabs());
    const last = nav.getByRole("link", { name: "Sources & Policies", exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    await last.click();
    await expect(page).toHaveURL(/\/admin\/intelligence\/sources$/);
  });
});
