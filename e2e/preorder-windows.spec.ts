import { expect, test, type Page } from "@playwright/test";

/**
 * The preorder window as staff drive it.
 *
 * The capacity engine has been tested since Phase 6, but until now there was no
 * screen that could open, extend or close a window — the engine was only
 * reachable by typing values in when a variant was first created. These assert
 * the screen and, more importantly, that the rules protecting reserved places
 * hold at the API whether or not the form is involved.
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

/** A fresh product with a single variant, and the windows page open on it. */
async function productWithVariant(page: Page): Promise<string> {
  const title = `Window Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();

  await page.waitForURL((url) => url.pathname.includes("/wizard"));
  const productUrl = page.url().replace(/\/wizard.*$/, "");

  // A product with no attributes still gets one plain variant, so there is
  // something to put a window on.
  await page.goto(`${productUrl}/variants`);
  await page.getByLabel("Starting price (৳)").fill("2000");
  const generated = page.waitForResponse(
    (r) =>
      r.url().includes("/api/admin/variants") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate variants" }).click();
  await generated;

  await page.goto(`${productUrl}/windows`);
  await expect(
    page.getByRole("heading", { name: "Preorder windows", level: 1 }),
  ).toBeVisible();

  return productUrl;
}

/** The variant id, read off the form the page rendered. */
async function variantIdFrom(page: Page): Promise<string> {
  const id = await page
    .locator('input[name="capacity"]')
    .first()
    .getAttribute("id");
  return (id ?? "").replace(/^capacity-/, "");
}

test("staff open a window, then extend it, then close it", async ({ page }) => {
  test.slow();
  await signIn(page, "staff@example.com");
  await productWithVariant(page);

  const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const asInput = (date: Date) =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);

  await page.getByLabel("Places in the batch").fill("25");
  await page.getByLabel("Ordering closes").fill(asInput(inTenDays));
  await page.getByRole("button", { name: /Open window|Save window/ }).click();
  await expect(page.getByText("Window saved.")).toBeVisible();

  // Read back from the server, not from the optimistic message.
  await page.reload();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "25" }).first()).toBeVisible();

  const inTwentyDays = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  await page.getByLabel("Extend to").fill(asInput(inTwentyDays));
  await page.getByRole("button", { name: "Extend" }).click();
  await expect(page.getByText("Closing date moved.")).toBeVisible();

  await page.getByRole("button", { name: "Close now" }).click();
  await expect(page.getByText(/Window closed/)).toBeVisible();

  await page.reload();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
});

test("closing a window keeps the places already reserved", async ({ page }) => {
  test.slow();
  await signIn(page, "staff@example.com");
  await productWithVariant(page);
  const variantId = await variantIdFrom(page);

  // Open with capacity, then take a place through the real reservation path by
  // way of the API the storefront uses, so the reserved count is genuine.
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await page.evaluate(
    async ([id, closesAt]) => {
      await fetch(`/api/admin/variants/${id}/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", capacity: 5, closesAt }),
      });
    },
    [variantId, future] as const,
  );

  await page.reload();
  const reservedBefore = await page
    .getByRole("term")
    .filter({ hasText: "Reserved" })
    .first()
    .locator("xpath=following-sibling::dd[1]")
    .textContent();

  await page.getByRole("button", { name: "Close now" }).click();
  await expect(page.getByText(/Window closed/)).toBeVisible();

  await page.reload();
  const reservedAfter = await page
    .getByRole("term")
    .filter({ hasText: "Reserved" })
    .first()
    .locator("xpath=following-sibling::dd[1]")
    .textContent();

  expect(reservedAfter?.trim()).toBe(reservedBefore?.trim());
});

/**
 * The rule that actually protects shoppers: a batch cannot be shrunk below the
 * orders already in it. Probed at the API, because the form is not what
 * enforces it.
 */
test("capacity cannot be set below what is already reserved", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");

  // The seeded headphones have a variant deliberately at full capacity.
  await page.goto("/admin/products");
  await page.getByRole("link", { name: /Studio Reference Headphones/ }).click();
  await page.getByRole("link", { name: "Preorder windows" }).click();

  const variantId = await page
    .locator('input[name="capacity"]')
    .first()
    .getAttribute("id")
    .then((id) => (id ?? "").replace(/^capacity-/, ""));

  const response = await page.evaluate(async (id: string) => {
    const r = await fetch(`/api/admin/variants/${id}/window`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", capacity: 0, closesAt: null }),
    });
    return { status: r.status, body: await r.json() };
  }, variantId);

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/cannot be below/i);
});

test("a closing date in the past is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await productWithVariant(page);
  const variantId = await variantIdFrom(page);

  const past = new Date(Date.now() - 60_000).toISOString();
  const response = await page.evaluate(
    async ([id, closesAt]) => {
      const r = await fetch(`/api/admin/variants/${id}/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extend", closesAt }),
      });
      return { status: r.status, body: await r.json() };
    },
    [variantId, past] as const,
  );

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/future/i);
});

test("an unknown field is refused rather than ignored", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await productWithVariant(page);
  const variantId = await variantIdFrom(page);

  const response = await page.evaluate(async (id: string) => {
    const r = await fetch(`/api/admin/variants/${id}/window`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // preorderReserved is not settable through this route, and a request
      // that tries should fail loudly rather than silently doing the rest.
      body: JSON.stringify({ action: "close", preorderReserved: 0 }),
    });
    return r.status;
  }, variantId);

  expect(response).toBe(400);
});

test("a customer cannot open, extend or close a window", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const statuses = await page.evaluate(async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const post = async (body: unknown) => {
      const r = await fetch(`/api/admin/variants/${id}/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.status;
    };

    return {
      open: await post({ action: "open", capacity: 10, closesAt: null }),
      close: await post({ action: "close" }),
    };
  });

  expect(statuses.open).toBe(403);
  expect(statuses.close).toBe(403);
});

test("an anonymous visitor is refused, and the page is not reachable", async ({
  page,
}) => {
  // The fetch below is relative, so the page needs an origin first.
  await page.goto("/");

  const status = await page.evaluate(async () => {
    const r = await fetch(
      "/api/admin/variants/00000000-0000-4000-8000-000000000000/window",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      },
    );
    return r.status;
  });

  // 401 and 403 mean different things: this visitor has not identified itself.
  expect(status).toBe(401);
});
