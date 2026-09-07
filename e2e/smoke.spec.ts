import { expect, test } from "@playwright/test";

test("app boots and renders the build status page", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /scaffold in place/i }),
  ).toBeVisible();
});
