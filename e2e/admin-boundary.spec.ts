import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The customer/staff boundary, for every admin route that exists — not a
 * hand-kept list (PRODUCTION-READINESS 18.1).
 *
 * Route handlers under app/api/admin and pages under app/admin are found on
 * disk. Each handler is called with each method it exports, as a signed-in
 * customer and as an anonymous visitor; each page is opened as a customer. A
 * route added later is covered without anyone remembering to add it here.
 *
 * Dynamic segments are filled with a random id, and bodies are empty: the
 * point is that the request is refused for who is asking, whatever it asks.
 */

const ROOT = process.cwd();

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function urlFor(file: string, base: string) {
  const parts = relative(join(ROOT, "app"), file).split(sep).slice(0, -1);
  return (
    "/" +
    parts
      .filter((part) => !(part.startsWith("(") && part.endsWith(")")))
      .map((part) => (part.startsWith("[") ? "00000000-0000-4000-8000-000000000000" : part))
      .join("/")
  ).replace(/^\/$/, base);
}

const handlers = walk(join(ROOT, "app", "api", "admin"))
  .filter((file) => file.endsWith(`${sep}route.ts`))
  .map((file) => {
    const source = readFileSync(file, "utf8");
    const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(
      (match) => match[1],
    );
    return { url: urlFor(file, "/"), methods };
  })
  .filter((handler) => handler.methods.length > 0);

const pages = walk(join(ROOT, "app", "admin"))
  .filter((file) => file.endsWith(`${sep}page.tsx`))
  .map((file) => urlFor(file, "/admin"));

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await response;
}

async function callAll(page: Page) {
  return page.evaluate(async (targets) => {
    const results: { url: string; method: string; status: number }[] = [];
    for (const target of targets) {
      for (const method of target.methods) {
        const response = await fetch(target.url, {
          method,
          headers: method === "GET" ? undefined : { "content-type": "application/json" },
          body: method === "GET" ? undefined : "{}",
          redirect: "manual",
        });
        results.push({ url: target.url, method, status: response.status });
      }
    }
    return results;
  }, handlers);
}

test("every admin route handler was found", () => {
  // A sanity floor, so a broken discovery cannot pass by finding nothing.
  expect(handlers.length).toBeGreaterThan(30);
  expect(pages.length).toBeGreaterThan(15);
});

test("a customer is refused by every admin route handler", async ({ page }) => {
  await signIn(page, "customer@example.com");
  const results = await callAll(page);
  const allowed = results.filter((result) => result.status !== 403);
  expect(allowed, "each of these answered a customer with something other than 403").toEqual([]);
});

test("an anonymous visitor is refused by every admin route handler", async ({ page }) => {
  await page.goto("/login");
  const results = await callAll(page);
  const allowed = results.filter((result) => result.status !== 401);
  expect(allowed, "each of these answered an anonymous visitor with something other than 401").toEqual([]);
});

test("a customer is turned away from every admin page", async ({ page }) => {
  // One full navigation per admin page, and the admin has passed thirty of
  // them. The assertion is unchanged; this only admits that the loop takes
  // longer than one test's ordinary budget.
  test.slow();
  await signIn(page, "customer@example.com");
  const reached: string[] = [];
  for (const url of pages) {
    const response = await page.goto(url);
    // The page decides while streaming, so the redirect can arrive in the
    // stream rather than as a status: wait for it to leave the admin area.
    await page.waitForURL((address) => !address.pathname.startsWith("/admin"), { timeout: 10_000 }).catch(() => undefined);
    const html = (await response?.text()) ?? "";
    const landed = new URL(page.url()).pathname;
    // Neither landing on the page nor any admin navigation in what was sent.
    if (landed.startsWith("/admin") || html.includes("aria-label=\"Admin")) reached.push(url);
  }
  expect(reached, "a customer reached these admin pages").toEqual([]);
});

test("a signed-out visitor to an admin or account page gets a real redirect to sign in", async ({ request }) => {
  for (const url of [...pages, "/account", "/account/orders"]) {
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status(), url).toBe(307);
    expect(response.headers()["location"], url).toContain("/login?next=");
  }
});
