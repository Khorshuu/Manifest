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

/** Creates a product and returns its admin page URL. */
async function createProduct(page: Page): Promise<string> {
  const title = `Photo Test ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/products/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save product" }).click();
  await page.waitForURL("**/admin/products");

  await page.getByRole("link", { name: title }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/products/"));

  return page.url();
}

test("staff upload a photograph and it appears on the product", async ({
  page,
}) => {
  await signIn(page, "staff@example.com");
  await createProduct(page);

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
  await page.waitForURL("**/admin/products");

  await page.getByRole("link", { name: title }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/products/"));

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
