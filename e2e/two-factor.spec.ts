import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Two-factor authentication in the browser, end to end: an admin turns it on,
 * signs out, and has to produce a code to get back in.
 *
 * The test generates codes the same way an authenticator app does — it has the
 * secret, because it just enrolled the account.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The same arithmetic an app does, kept independent of lib/auth/totp.ts. */
function codeFor(secretBase32: string, now = Date.now()): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of secretBase32.toUpperCase().replace(/=+$/, "")) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  const counter = Math.floor(now / 1000 / 30);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counterBytes)
    .digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, "0");
}

/** A code from the next step, for when the current one has been spent. */
function nextCode(secret: string): string {
  return codeFor(secret, Date.now() + 30_000);
}

async function signOut(page: Page) {
  // Any route with an origin will do, and the home page is the heaviest one in
  // the application — this only needs somewhere to fetch the logout from.
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
}

/** Registers a throwaway account, so the seeded ones keep working. */
async function registerAndSignIn(page: Page): Promise<string> {
  const email = `twofactor-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await signOut(page);

  const status = await page.evaluate(async (address: string) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Shopper", email: address, password: "password123" }),
    });
    return response.status;
  }, email);

  expect(status).toBe(201);
  return email;
}

async function signIn(page: Page, email: string) {
  // Registering signs the account in, so /login would otherwise redirect away.
  await signOut(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Turns it on through the UI and returns the secret and recovery codes. */
async function enrol(page: Page): Promise<{ secret: string; codes: string[] }> {
  await page.goto("/account/security");
  await page
    .getByRole("button", { name: "Set up two-factor authentication" })
    .click();

  const secret = (
    await page.getByText(/^[A-Z2-7]{32}$/).first().innerText()
  ).trim();

  await page.getByLabel("Code from the app").fill(codeFor(secret));
  await page.getByRole("button", { name: "Turn it on" }).click();

  await expect(
    page.getByRole("heading", { name: "Two-factor authentication is on" }),
  ).toBeVisible();

  const codes = await page
    .getByRole("listitem")
    .filter({ hasText: /^[0-9A-F]{8}-[0-9A-F]{8}$/ })
    .allInnerTexts();

  expect(codes).toHaveLength(10);
  return { secret, codes: codes.map((code) => code.trim()) };
}

test("an account turns it on, and then needs a code to sign in", async ({
  page,
}) => {
  test.slow();

  const email = await registerAndSignIn(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const { secret } = await enrol(page);

  await signOut(page);
  await signIn(page, email);

  // The password alone does not get in.
  await expect(
    page.getByRole("heading", { name: "One more step" }),
  ).toBeVisible();

  // The pending cookie authenticates nothing: an endpoint that needs a real
  // session refuses it.
  const blocked = await page.evaluate(async () => {
    const response = await fetch("/api/account/two-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "begin" }),
    });
    return response.status;
  });
  expect(blocked).toBe(401);

  // A wrong code is refused.
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code is not right.")).toBeVisible();

  // The right one gets in.
  await page.getByLabel("Code").fill(nextCode(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  await page.goto("/account");
  await expect(page.getByText(email)).toBeVisible();
});

test("a pending sign-in authenticates nothing", async ({ page }) => {
  test.slow();

  const email = await registerAndSignIn(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await enrol(page);

  await signOut(page);
  await signIn(page, email);
  await expect(
    page.getByRole("heading", { name: "One more step" }),
  ).toBeVisible();

  // The cookie exists, but the account page still redirects to sign-in.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("a recovery code works when the phone is gone, once", async ({ page }) => {
  test.slow();

  const email = await registerAndSignIn(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const { codes } = await enrol(page);

  await signOut(page);
  await signIn(page, email);
  await page.getByLabel("Code").fill(codes[0]);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  // The same code is spent and cannot be used again.
  await signOut(page);
  await signIn(page, email);
  await page.getByLabel("Code").fill(codes[0]);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code is not right.")).toBeVisible();
});

test("it can be turned off again with a current code", async ({ page }) => {
  test.slow();

  const email = await registerAndSignIn(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const { secret } = await enrol(page);

  await page.goto("/account/security");
  await page
    .getByLabel("Enter a current code to turn it off")
    .fill(nextCode(secret));
  await page
    .getByRole("button", { name: "Turn off two-factor authentication" })
    .click();

  await expect(
    page.getByRole("button", { name: "Set up two-factor authentication" }),
  ).toBeVisible();

  // And signing in no longer asks for a code.
  await signOut(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await expect(
    page.getByRole("heading", { name: "One more step" }),
  ).toHaveCount(0);
});

test("nobody can offer a code without passing the password first", async ({
  page,
}) => {
  await signOut(page);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/two-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    return response.status;
  });

  expect(status).toBe(401);
});

test("an anonymous visitor cannot start an enrolment", async ({ page }) => {
  await signOut(page);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/account/two-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "begin" }),
    });
    return response.status;
  });

  expect(status).toBe(401);
});
