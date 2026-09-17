import { expect, test } from "@playwright/test";

/**
 * The in-site sign-in dialog (D-042), which is how shoppers sign in and sign
 * up from any page: creating an account signs you in where you are, signing
 * out ends it, signing back in works, and a wrong password is refused inside
 * the dialog without saying whether the account exists
 * (PRODUCTION-READINESS 18.1).
 */

test("create an account, sign out, and sign back in from the header dialog", async ({ page }) => {
  const email = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = "a-long-enough-password";

  await page.goto("/help");
  const header = page.locator("header").first();

  // Sign up.
  await header.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Create account" }).first().click();
  await dialog.getByLabel("First name").fill("Rafi");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Mobile number").fill(`+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`);
  await dialog.getByLabel("Password").fill(password);
  await dialog.locator("form").getByRole("button", { name: "Create account" }).click();

  // Signed in, on the same page.
  await expect(header.getByRole("button", { name: /Rafi/ })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/help/);

  // Sign out from the account menu.
  await header.getByRole("button", { name: /Rafi/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(header.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
  const account = await page.request.get("/account", { maxRedirects: 0 });
  expect(account.status()).toBe(307);

  // A wrong password is refused in the dialog.
  await header.getByRole("button", { name: "Sign in" }).click();
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Password").fill("not-the-password");
  await dialog.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(dialog.getByText(/email and password combination is not correct/i)).toBeVisible();

  // The right one signs in.
  await dialog.getByLabel("Password").fill(password);
  await dialog.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(header.getByRole("button", { name: /Rafi/ })).toBeVisible({ timeout: 15_000 });
});
