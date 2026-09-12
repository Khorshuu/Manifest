import { expect, test } from "@playwright/test";

/**
 * The product detail experience: the gallery a shopper clicks through, and
 * the sections below the buy box.
 *
 * These run against the seeded headphones, which is the worked example — the
 * one listing with every optional field filled in. The candy box is the
 * opposite case, and is used here to check the other half of the rule: a
 * section with nothing to say does not appear at all.
 */

const HEADPHONES = "/products/studio-reference-headphones";

test("the gallery switches image when a thumbnail is chosen", async ({
  page,
}) => {
  await page.goto(HEADPHONES);

  const first = page.getByAltText(
    "Open-back studio reference headphones, three-quarter view",
  );
  await expect(first).toBeVisible();

  await page
    .getByRole("button", {
      name: "Show The headphones beside a portable amplifier",
    })
    .click();

  await expect(
    page.getByAltText("The headphones beside a portable amplifier"),
  ).toBeVisible();
  // The thumbnail says which one is showing, not only by colour.
  await expect(
    page.getByRole("button", {
      name: "Show The headphones beside a portable amplifier",
    }),
  ).toHaveAttribute("aria-current", "true");
});

test("the main image opens a lightbox that closes on escape", async ({
  page,
}) => {
  await page.goto(HEADPHONES);

  await page
    .getByRole("button", { name: /^Open .* full screen$/ })
    .first()
    .click();

  const lightbox = page.getByRole("dialog");
  await expect(lightbox).toBeVisible();

  // Arrow keys move through the images while it is open.
  await page.keyboard.press("ArrowRight");
  await expect(
    lightbox.getByAltText("The headphones beside a portable amplifier"),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("the page shows the sections the listing actually fills in", async ({
  page,
}) => {
  await page.goto(HEADPHONES);

  await expect(
    page.getByRole("heading", { name: "Key features" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What's in the box" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Warranty" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Certifications and safety" }),
  ).toBeVisible();
  /*
   * The specification is a tab rather than a heading of its own (D-043), so
   * the table is behind it and the shopper has to ask for it.
   */
  const specification = page.getByRole("tab", { name: "Specification" });
  await expect(specification).toBeVisible();
  await specification.click();

  // A category-defined specification, answered by the product.
  await expect(page.getByRole("row", { name: /Impedance/ })).toContainText(
    "250 ohm",
  );
  // One row per fact: the table draws on several sources and must not print
  // the same label twice.
  await expect(page.getByRole("row", { name: /Impedance/ })).toHaveCount(1);
  await expect(page.getByRole("row", { name: /Earcup backing/ })).toContainText(
    "Open",
  );

  // Lifestyle imagery is its own band, kept out of the buy-box gallery.
  await expect(
    page.getByRole("heading", { name: /in use$/ }),
  ).toBeVisible();
});

test("a listing with no warranty shows no warranty section", async ({
  page,
}) => {
  await page.goto("/products/seasonal-candy-variety-box");

  await expect(page.getByRole("heading", { name: "Warranty" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Certifications and safety" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "What's in the box" }),
  ).toHaveCount(0);
});

test("a sale price is shown beside what it replaces", async ({ page }) => {
  await page.goto(HEADPHONES);

  // The seeded first colourway is on offer.
  await expect(
    page.getByText("BDT 28,900").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Regular price").filter({ visible: true }).first(),
  ).toBeAttached();
  await expect(
    page.getByText(/^Save \d+%$/).filter({ visible: true }).first(),
  ).toBeVisible();
});

test("the gallery works at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(HEADPHONES);

  await expect(
    page.getByAltText(
      "Open-back studio reference headphones, three-quarter view",
    ),
  ).toBeVisible();

  // Nothing overflows sideways — the rule the whole page has to keep.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
});
