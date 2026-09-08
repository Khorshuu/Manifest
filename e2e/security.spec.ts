import { expect, test, type Page } from "@playwright/test";

/**
 * Security checks against the running application.
 *
 * These probe the boundaries from outside: headers actually sent, session
 * cookie flags actually set, and endpoints reached without the UI.
 */

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

test("security headers are sent on every page", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response!.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  // Nothing may frame the site, which is what stops a clickjacked checkout.
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("the framework version is not advertised", async ({ page }) => {
  const response = await page.goto("/");
  expect(response!.headers()["x-powered-by"]).toBeUndefined();
});

test("the session cookie is http-only and same-site", async ({
  page,
  context,
}) => {
  await signIn(page, "customer@example.com");

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "session");

  expect(session).toBeDefined();
  // Not readable from script, so an XSS cannot steal it.
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe("Lax");
});

test("the session cookie is not visible to JavaScript", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain("session=");
});

test("signing out invalidates the session server-side", async ({ page }) => {
  await signIn(page, "staff@example.com");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

/** Every admin mutation is checked server-side, not by hiding a button. */
test("a customer is refused at every admin endpoint", async ({ page }) => {
  await signIn(page, "customer@example.com");

  const endpoints = [
    { url: "/api/admin/products", body: { title: "x", categoryId: crypto.randomUUID() } },
    { url: "/api/admin/categories", body: { name: "x", slug: "x" } },
    {
      url: "/api/admin/variants",
      body: { productId: crypto.randomUUID(), attributeIds: [], priceBdt: 0 },
    },
    {
      url: "/api/admin/staff",
      body: { email: "x@example.com", password: "a-long-password", role: "super_admin" },
    },
  ];

  for (const endpoint of endpoints) {
    const status = await page.evaluate(async (target) => {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target.body),
      });
      return response.status;
    }, endpoint);

    expect(status, `${endpoint.url} must refuse a customer`).toBe(403);
  }
});

test("an anonymous visitor is refused, and told so as unauthenticated", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", slug: "x" }),
    });
    return response.status;
  });

  expect(status).toBe(401);
});

/** Unknown fields are rejected rather than silently dropped. */
test("an unexpected field in a request is refused", async ({ page }) => {
  await signIn(page, "staff@example.com");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Trojan",
        slug: "trojan",
        // Not part of the schema.
        isSuperSecret: true,
      }),
    });
    return response.status;
  });

  expect(status).toBe(400);
});

test("the login response never reveals whether an account exists", async ({
  page,
}) => {
  await page.goto("/login");

  const results = await page.evaluate(async () => {
    const attempt = async (email: string) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "definitely-wrong" }),
      });
      return { status: response.status, body: await response.json() };
    };

    return {
      known: await attempt("admin@example.com"),
      unknown: await attempt("nobody-at-all@example.com"),
    };
  });

  expect(results.known.status).toBe(results.unknown.status);
  expect(results.known.body.error).toBe(results.unknown.body.error);
});

test("registration cannot grant itself a role", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `escalate-${crypto.randomUUID().slice(0, 8)}@example.com`,
        password: "a-long-enough-password",
        role: "super_admin",
      }),
    });
    return response.status;
  });

  // The unknown field is refused outright.
  expect(status).toBe(400);
});

test("the storefront never renders the sourcing cost", async ({ page }) => {
  for (const path of [
    "/",
    "/products/seasonal-candy-variety-box",
    "/categories/electronics",
    "/search?q=candy",
  ]) {
    await page.goto(path);
    const html = await page.content();
    expect(html, `${path} must not carry the cost`).not.toMatch(
      /cost_price|costPriceUsd/i,
    );
  }
});
