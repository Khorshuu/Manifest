import { expect, test, type Page } from "@playwright/test";

/**
 * SeoPulse's recommendations in the sections they belong to, and whose words
 * are whose (D-120).
 *
 * The facts are set through the same API the editor saves through, and the
 * research runs locally with the rules generator. What this proves is the
 * part the screen owns: a field SeoPulse wrote can be regenerated with a
 * click, and a field staff wrote is only ever replaced by an explicit,
 * reviewed choice.
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

const FACTS = [
  { label: "Sensor", value: "BAMF 2.0 optical sensor" },
  { label: "Connectivity", value: "2.4 GHz wireless, wired" },
  { label: "Battery life", value: "Up to 80 hours" },
];

/** A product with enough established about it for SeoPulse to write its content. */
async function researchedProduct(page: Page): Promise<string> {
  await page.goto("/admin/products/new");
  await page.getByLabel("Product name").fill(`Model O ${crypto.randomUUID().slice(0, 8)}`);
  await page.getByRole("button", { name: "Save without SeoPulse" }).click();
  await page.waitForURL((url) => /^[/]admin[/]products[/][0-9a-f-]{36}$/.test(url.pathname));
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const status = await api(page, `/api/admin/products/${id}`, "PATCH", {
    brand: "Glorious",
    identity: { modelNumber: "GLO-OC-WL-BLK" },
    specTable: FACTS,
    measurements: [{ label: "Weight", value: "69 g" }],
    boxContents: ["1× USB receiver", "1× USB-A to USB-C cable"],
  });
  expect(status).toBe(200);
  return id;
}

async function api(page: Page, url: string, method: string, body: unknown): Promise<number> {
  return page.evaluate(
    async ({ url, method, body }) => {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    },
    { url, method, body },
  );
}

/** Better knowledge arrives and SeoPulse prepares again, the way preparation does. */
async function knowledgeImproves(page: Page, id: string, extra: { label: string; value: string }[]) {
  expect(await api(page, `/api/admin/products/${id}`, "PATCH", { specTable: [...FACTS, ...extra] })).toBe(200);
  expect([200, 201]).toContain(await api(page, `/api/admin/products/${id}/seo-pulse`, "POST", { requestKey: crypto.randomUUID(), fresh: true }));
}

test("a description SeoPulse wrote is regenerated with one click; one staff wrote is kept", async ({ page }) => {
  test.slow();
  await signIn(page, "staff@example.com");
  const id = await researchedProduct(page);
  expect(await api(page, `/api/admin/products/${id}/seo-pulse/fill`, "POST", {})).toBe(200);
  await knowledgeImproves(page, id, [{ label: "Polling rate", value: "1000 Hz" }]);

  await page.goto(`/admin/products/${id}?section=content`);
  const panel = page.getByTestId("seo-pulse-recommendations");
  const description = panel.locator('[data-field="descriptionHtml"]');
  await expect(description).toHaveAttribute("data-owner", "seo_pulse");
  await expect(description.getByText(/written by SeoPulse and nobody has edited it since/)).toBeVisible();

  // Reviewing shows the new version before anything is written.
  await description.getByRole("button", { name: "Review SeoPulse version" }).click();
  await expect(description.getByTestId("seo-pulse-proposed")).toContainText("Polling rate: 1000 Hz");
  await expect(page.locator("#descriptionHtml")).not.toHaveValue(/Polling rate/);

  const regenerated = page.waitForResponse((r) => r.url().endsWith("/seo-pulse/regenerate") && r.request().method() === "POST");
  await description.getByRole("button", { name: "Regenerate with SeoPulse" }).click();
  expect((await regenerated).status()).toBe(200);
  await expect(page.locator("#descriptionHtml")).toHaveValue(/Polling rate: 1000 Hz/);

  // Staff now write their own description.
  await page.locator("#descriptionHtml").fill("<p>Our buyers' own words about the Model O.</p>");
  const saved = page.waitForResponse((r) => r.url().includes(`/api/admin/products/${id}`) && r.request().method() === "PATCH");
  await page.locator("#descriptionHtml").locator("xpath=ancestor::form[1]").getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);

  // Knowledge improves again; SeoPulse prepares a newer version and writes nothing.
  await knowledgeImproves(page, id, [{ label: "Polling rate", value: "1000 Hz" }, { label: "Switch type", value: "Mechanical" }]);
  await page.goto(`/admin/products/${id}?section=content`);
  await expect(page.locator("#descriptionHtml")).toHaveValue("<p>Our buyers' own words about the Model O.</p>");

  const staffOwned = page.getByTestId("seo-pulse-recommendations").locator('[data-field="descriptionHtml"]');
  await expect(staffOwned).toHaveAttribute("data-owner", "staff");
  await expect(staffOwned.getByRole("button", { name: "Regenerate with SeoPulse" })).toHaveCount(0);
  // Replace is offered only after the SeoPulse version has been opened.
  await expect(staffOwned.getByRole("button", { name: "Replace with SeoPulse version" })).toHaveCount(0);
  await staffOwned.getByRole("button", { name: "Review SeoPulse version" }).click();
  await expect(staffOwned.getByRole("button", { name: "Replace with SeoPulse version" })).toBeVisible();

  await staffOwned.getByRole("button", { name: "Keep current" }).click();
  await expect(page.getByTestId("seo-pulse-recommendations").locator('[data-field="descriptionHtml"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#descriptionHtml")).toHaveValue("<p>Our buyers' own words about the Model O.</p>");

  // Asked without choosing Replace, the server refuses to touch staff's words.
  const runId = await page.evaluate(async (productId: string) => {
    const response = await fetch(`/api/admin/products/${productId}/seo-pulse`);
    const body = await response.json();
    return body.latest?.id as string;
  }, id);
  expect(await api(page, `/api/admin/products/${id}/seo-pulse/regenerate`, "POST", { runId, fields: ["descriptionHtml"] })).toBe(409);
});

test("a customer cannot regenerate a product's content", async ({ page }) => {
  await signIn(page, "customer@example.com");
  const status = await api(page, "/api/admin/products/00000000-0000-4000-8000-000000000001/seo-pulse/regenerate", "POST", {
    runId: "00000000-0000-4000-8000-000000000002",
    fields: ["descriptionHtml"],
    replaceStaff: true,
  });
  expect(status).toBe(403);
});
