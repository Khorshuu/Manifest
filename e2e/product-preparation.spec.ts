import { expect, test, type Page } from "@playwright/test";

/**
 * Adding a product the way a product-entry employee does it (D-116).
 *
 * The benchmark this spec holds the interface to: someone hired yesterday can
 * add a product without being told what the knowledge base, an enrichment run
 * or a verification policy is. So every assertion here is written in the words
 * the screen uses, and several of them are assertions that internal words are
 * *absent*.
 *
 * Background jobs are not driven from a browser, so nothing here waits for a
 * preparation run to finish. What it proves is the part the screen owns: the
 * run is started once, it is found again after a refresh, it reports itself in
 * ordinary language, and the manual path still exists beside it.
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

const productPage = /^[/]admin[/]products[/][0-9a-f-]{36}$/;

test("the Add Product screen asks for the product, not for a database record", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  // The three things a person genuinely has to know.
  await expect(page.getByLabel("Product name")).toBeVisible();
  await expect(page.getByLabel("Brand")).toBeVisible();
  await expect(page.getByLabel("Category")).toBeVisible();

  // Both ways out of the screen are offered, and the researched one leads.
  await expect(page.getByRole("button", { name: "Research & Prepare with SeoPulse" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save without SeoPulse" })).toBeVisible();

  // What SeoPulse now writes is not asked for up front any more.
  await expect(page.getByLabel("Description")).toHaveCount(0);
  await expect(page.getByLabel("Key points")).toHaveCount(0);
  await expect(page.getByLabel("SEO title")).toHaveCount(0);

  // The optional identity fields are behind one control, and the Manifest SKU
  // is somewhere else entirely.
  await expect(page.getByLabel("Model", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Add details" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Manufacturer part number (MPN)")).toBeVisible();
  await expect(page.getByLabel("Official product URL")).toBeVisible();
  await expect(page.getByLabel("Manifest SKU")).toBeVisible();

  // Whether discovery is set up is stated; which service would do it is not.
  await expect(page.getByText(/Automatic source discovery/)).toBeVisible();
  await expect(page.getByText(/Brave/i)).toHaveCount(0);
});

test("Research & Prepare creates the product and starts one run, which survives a refresh", async ({ page }) => {
  test.slow();
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  const title = `Prepared ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Product name").fill(title);
  await page.getByLabel("Brand").fill("Harbor Acoustics");
  await page.getByRole("button", { name: "Add details" }).click();
  await page.getByLabel("Model number").fill("HP-900");
  await page
    .getByLabel("Official product URL")
    .fill("https://harbor-acoustics.example/hp-900");

  await page.getByRole("button", { name: "Research & Prepare with SeoPulse" }).click();

  // One continuous movement: no second screen, no second button to press.
  await page.waitForURL((url) => productPage.test(url.pathname));
  const panel = page.getByTestId("preparation-panel");
  await expect(panel).toBeVisible();

  const runId = await panel.getAttribute("data-run");
  expect(runId).toBeTruthy();

  // The progress surface speaks about the product, not about the machinery.
  await expect(panel.getByText("Product identified")).toBeVisible();
  await expect(panel.getByText("Sources found")).toBeVisible();
  const panelText = await panel.innerText();
  // No code, no internal name, and nothing underscored.
  for (const internal of ["PKB", "NEEDS_REVIEW", "IDENTIFYING", "ProductResearchProvider", "enrichment", "claim", "evidence"]) {
    expect(panelText, internal).not.toContain(internal);
  }
  expect(panelText).not.toMatch(/[A-Z]{3,}_[A-Z]/);

  // Coming back finds the same run. A remount never starts a second one.
  await page.reload();
  await expect(page.getByTestId("preparation-panel")).toHaveAttribute("data-run", runId!);
  await page.goto(page.url().split("?")[0]);
  await expect(page.getByTestId("preparation-panel")).toHaveAttribute("data-run", runId!);
});

test("Save without SeoPulse leaves a usable product and offers preparation later", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  const title = `Manual ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Product name").fill(title);
  await page.getByLabel("Brand").fill("Northfield Supply");
  await page.getByRole("button", { name: "Save without SeoPulse" }).click();

  await page.waitForURL((url) => productPage.test(url.pathname));
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();

  // Nothing was prepared, so the product offers it rather than reporting it.
  await expect(page.getByTestId("preparation-start")).toBeVisible();
  await expect(page.getByTestId("preparation-panel")).toHaveCount(0);

  // And the editor is fully usable by hand.
  const nav = page.getByRole("navigation", { name: "Product sections" });
  for (const section of ["Product identity", "Product content", "Selling information", "Images"]) {
    await expect(nav.getByRole("button", { name: new RegExp(section) })).toBeVisible();
  }
});

test("an unresearched product says so in the editor and in the staff preview (D-119)", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  const title = `Unresearched ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Product name").fill(title);
  await page.getByLabel("Brand").fill("Northfield Supply");
  await page.getByRole("button", { name: "Save without SeoPulse" }).click();
  await page.waitForURL((url) => productPage.test(url.pathname));

  const editorStatus = page.locator('[data-research-state="incomplete"]');
  await expect(editorStatus).toContainText("Research incomplete");
  await expect(editorStatus).toContainText("SeoPulse still needs product information");

  // The preview still renders the page, with the warning above it.
  const previewHref = await page.locator('a[href*="?preview=1"]').first().getAttribute("href");
  await page.goto(previewHref!);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const banner = page.locator('[data-research-state="incomplete"]');
  await expect(banner).toContainText("Research incomplete");
  await expect(banner.getByRole("link", { name: "Continue product preparation" })).toHaveAttribute(
    "href",
    new RegExp("^/admin/products/[0-9a-f-]{36}$"),
  );
});

test("a shopper never sees the research state, only staff previewing", async ({ page }) => {
  await page.goto("/products/studio-reference-headphones");
  await expect(page.locator("[data-research-state]")).toHaveCount(0);
  await page.goto("/products/studio-reference-headphones?preview=1");
  await expect(page.locator("[data-research-state]")).toHaveCount(0);
});

test("the editor is ordered for daily work, and keeps the advanced tools out of the way", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products?q=Studio+Reference+Headphones");
  await page.getByRole("link", { name: "Studio Reference Headphones", exact: true }).first().click();
  await page.waitForURL((url) => productPage.test(url.pathname));

  const nav = page.getByRole("navigation", { name: "Product sections" });
  await expect(nav.getByRole("button").first()).toBeVisible();
  const labels = await nav.getByRole("button").allInnerTexts();
  const order = labels.map((label) => label.replace(/^\d+\.\s*/, "").trim());
  expect(order.slice(0, 6)).toEqual([
    "Product identity",
    "Product content",
    "Specifications",
    "Images",
    "Selling information",
    "SEO & search",
  ]);

  // One publishing answer, from the checks that already existed.
  await expect(page.getByRole("heading", { name: "Before publishing" })).toBeVisible();

  // The identity panel says how settled the identity is, in plain words.
  await expect(page.getByText(/Identified|Needs review|Needs information|Not identified yet/).first()).toBeVisible();

  // The old primary action is still available, and no longer prominent.
  const advanced = page.getByRole("group").filter({ hasText: "Advanced tools" });
  await expect(page.getByRole("button", { name: /Fill with SEO Pulse/ })).toBeHidden();
  await advanced.getByText("Advanced tools").click();
  await expect(page.getByRole("button", { name: /Fill with SEO Pulse/ })).toBeVisible();
  await expect(advanced.getByRole("link", { name: "Open product intelligence" })).toBeVisible();
});

test("the important controls stay usable on a phone", async ({ page, isMobile }) => {
  test.skip(!isMobile, "The narrow layout is what is being checked.");
  await signIn(page, "staff@example.com");
  await page.goto("/admin/products/new");

  const prepare = page.getByRole("button", { name: "Research & Prepare with SeoPulse" });
  await expect(prepare).toBeVisible();
  const box = await prepare.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);

  // No sideways scrolling on the narrowest admin screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
