import { expect, test, type Page } from "@playwright/test";

/**
 * Product photography in the browser.
 *
 * The rule MASTER_PRODUCT_SPEC.md calls out by name: only staff may upload
 * product media, enforced server-side and not by hiding the form.
 */

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
 * Opens one section of the product editor: the editor is one page of
 * sections (D-040), and the jump bar at the top scrolls to any of them.
 */
async function openSection(page: Page, label: string) {
  await page
    .getByRole("navigation", { name: "Product sections" })
    .getByRole("button", { name: new RegExp(label) })
    .click();
}

/** Creates a product and returns its admin page URL. */
async function createProduct(page: Page): Promise<string> {
  const title = `Photo Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();

  // Creating opens the setup wizard; these tests want the product page.
  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  await page.goto(page.url().split("?")[0]);

  return page.url();
}

test("staff upload a photograph and it appears on the product", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

  // Photography lives in the editor's Media panel.
  await openSection(page, "Media");

  await expect(page.getByText("No photography yet.")).toBeVisible();

  await page.getByLabel("Photograph", { exact: true }).setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await page
    .getByLabel("Describe the photograph")
    .fill("A candy box in its retail packaging");

  const uploaded = page.waitForResponse(
    (r) => r.url().includes("/images") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add photograph" }).click();
  expect((await uploaded).status()).toBe(201);

  await expect(page.getByText("Photograph added.")).toBeVisible();
  await expect(
    page.getByAltText("A candy box in its retail packaging"),
  ).toBeVisible({ timeout: 15_000 });
});

/** Alternative text is not optional. */
test("an upload without a description is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const productUrl = await createProduct(page);
  const productId = productUrl.split("/").pop()!;

  const result = await page.evaluate(async (id: string) => {
    const data = new FormData();
    data.append(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], "x.png", {
        type: "image/png",
      }),
    );
    data.append("altText", "   ");

    const response = await fetch(`/api/admin/products/${id}/images`, {
      method: "POST",
      body: data,
    });
    return { status: response.status, body: await response.json() };
  }, productId);

  expect(result.status).toBe(400);
  expect(result.body.error).toMatch(/screen reader/i);
});

/**
 * A browser content type is a claim. This posts a shell script labelled as a
 * PNG, which is what an attacker does.
 */
test("a script disguised as an image is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const productUrl = await createProduct(page);
  const productId = productUrl.split("/").pop()!;

  const result = await page.evaluate(async (id: string) => {
    const data = new FormData();
    data.append(
      "file",
      new File(["#!/bin/sh\necho pwned\n"], "photo.png", {
        type: "image/png",
      }),
    );
    data.append("altText", "Looks innocent");

    const response = await fetch(`/api/admin/products/${id}/images`, {
      method: "POST",
      body: data,
    });
    return { status: response.status, body: await response.json() };
  }, productId);

  expect(result.status).toBe(400);
  expect(result.body.error).toMatch(/not a JPEG, PNG, WebP, or AVIF/i);
});

test("a customer cannot upload product media", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const productUrl = await createProduct(page);
  const productId = productUrl.split("/").pop()!;

  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async (id: string) => {
    const data = new FormData();
    data.append(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], "x.png", {
        type: "image/png",
      }),
    );
    data.append("altText", "Sneaky");

    const response = await fetch(`/api/admin/products/${id}/images`, {
      method: "POST",
      body: data,
    });
    return { status: response.status };
  }, productId);

  expect(result.status).toBe(403);
});

test("a customer cannot remove product media", async ({ page }) => {
  await signIn(page, "staff@example.com");
  const productUrl = await createProduct(page);
  const productId = productUrl.split("/").pop()!;

  await signIn(page, "customer@example.com");

  const result = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/admin/products/${id}/images`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "remove",
        imageId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    return { status: response.status };
  }, productId);

  expect(result.status).toBe(403);
});

test("an uploaded photograph reaches the storefront", async ({ page }) => {
  await signIn(page, "staff@example.com");

  // A published product, so the storefront will show it.
  const title = `Shown ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Status").selectOption("preorder_open");
  await page.getByRole("button", { name: "Save product" }).click();

  // Creating opens the product editor.
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  await page.goto(page.url().split("?")[0]);

  // Photography lives in the editor's Media panel.
  await openSection(page, "Media");

  await page.getByLabel("Photograph", { exact: true }).setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await page.getByLabel("Describe the photograph").fill("The product itself");

  const uploaded = page.waitForResponse(
    (r) => r.url().includes("/images") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add photograph" }).click();
  const url = (await uploaded.then((r) => r.json())).image.url as string;

  // The file is served from the site.
  const served = await page.evaluate(async (path: string) => {
    const response = await fetch(path);
    return { status: response.status, type: response.headers.get("content-type") };
  }, url);

  expect(served.status).toBe(200);
  expect(served.type).toContain("image");
});

/**
 * The upload route is the one place the application reads a file path from a
 * URL, so it gets its own probes rather than being covered only by the happy
 * path above.
 *
 * It exists because uploads cannot live in `public/`: Next resolves that
 * directory when the application is built, so a file written there afterwards
 * is served in development and 404s under `next start`. That was invisible
 * until the suite was run against a production build.
 */
test("the upload route refuses anything that is not a generated key", async ({
  page,
}) => {
  // The fetches below are relative, so the page needs an origin first.
  await page.goto("/");

  const attempts = [
    // Traversal, in the spellings a proxy might decode differently.
    "..%2F..%2Fpackage.json",
    "..%5C..%5Cpackage.json",
    "%2e%2e%2fpackage.json",
    // A real generated shape, but an extension that is not an image.
    "0f9c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f.sh",
    // Well-formed and simply absent.
    "0f9c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f.png",
  ];

  for (const attempt of attempts) {
    const status = await page.evaluate(async (key: string) => {
      const response = await fetch(`/uploads/${key}`);
      return response.status;
    }, attempt);

    /*
     * Any refusal, not one particular code. Some of these encodings never
     * reach the handler at all — the framework rejects the path itself with a
     * 400 in development and a 404 in production — and pinning the number
     * would make the test assert which layer refused rather than that the file
     * was refused, which is the part that matters.
     */
    expect(
      status,
      `/uploads/${attempt} should not be served`,
    ).toBeGreaterThanOrEqual(400);
  }
});
