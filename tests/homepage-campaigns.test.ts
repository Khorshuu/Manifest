/**
 * The homepage's promotional campaigns (DECISIONS.md D-035).
 *
 * What is protected: a slide and its four tiles are one record; only slides
 * switched on with a photograph reach the storefront, so an unused slot is
 * never a blank slide; destinations cannot be pointed at a script or another
 * protocol; images are uploads, never URLs; and only `homepage.manage` writes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { siteSettings, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  CAMPAIGNS_SETTING_KEY,
  HERO_SETTING_KEY,
  clearCampaignImage,
  getCampaignSettings,
  getLiveCampaigns,
  moveCampaign,
  normaliseDestination,
  setCampaignImage,
  updateCampaign,
} from "@/lib/homepage";
import { setMediaProviderForTesting, type MediaProvider } from "@/lib/providers/media";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const marketing: SessionUser = { id: "", email: "marketing@example.com", role: "marketing" };
const catalogue: SessionUser = { id: "", email: "catalogue@example.com", role: "product_manager" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };

let uploads = 0;
const deleted: string[] = [];
const fakeMedia: MediaProvider = {
  async upload() {
    uploads += 1;
    return { key: `file-${uploads}`, url: `/uploads/file-${uploads}.jpg` };
  },
  async delete(key: string) {
    deleted.push(key);
  },
} as unknown as MediaProvider;

const image = { data: Buffer.from("x"), originalName: "a.jpg", contentType: "image/jpeg" };

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  uploads = 0;
  deleted.length = 0;
  setMediaProviderForTesting(fakeMedia);
  const rows = await harness.db
    .insert(users)
    .values([
      { email: marketing.email, passwordHash: "x", role: "marketing" },
      { email: catalogue.email, passwordHash: "x", role: "product_manager" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  for (const actor of [marketing, catalogue, customer]) {
    actor.id = rows.find((row) => row.email === actor.email)!.id;
  }
});

afterEach(() => {
  setMediaProviderForTesting(undefined);
});

describe("reading", () => {
  it("has five empty, switched-off slots and nothing live on a new shop", async () => {
    const settings = await getCampaignSettings();
    expect(settings.slides).toHaveLength(5);
    expect(settings.slides.every((slide) => !slide.active && slide.showcase.length === 4)).toBe(true);
    expect(await getLiveCampaigns()).toEqual([]);
  });

  it("turns the old single hero into the first slide", async () => {
    await harness.db.insert(siteSettings).values({
      key: HERO_SETTING_KEY,
      valueJson: {
        value: { imageUrl: "/uploads/hero.jpg", imageKey: "hero", focalX: 30, focalY: 70, contrast: "dark" },
      },
    });
    const [live] = await getLiveCampaigns();
    expect(live).toMatchObject({ imageUrl: "/uploads/hero.jpg", focalX: 30, focalY: 70, contrast: "dark" });
  });

  it("degrades to empty slots rather than throwing on a corrupt row", async () => {
    await harness.db
      .insert(siteSettings)
      .values({ key: CAMPAIGNS_SETTING_KEY, valueJson: { value: { slides: "nope" } } });
    expect((await getCampaignSettings()).slides).toHaveLength(5);
  });
});

describe("what reaches the storefront", () => {
  it("shows only switched-on slides with a photograph, in slot order, with their own tiles", async () => {
    await setCampaignImage(marketing, 0, { kind: "hero" }, image);
    await setCampaignImage(marketing, 0, { kind: "tile", tile: 1 }, image);
    await updateCampaign(marketing, 0, {
      active: true,
      heroUrl: "/categories/snacks",
      showcase: [{}, { title: "American Snacks", url: "/categories/snacks" }],
    });
    await setCampaignImage(marketing, 3, { kind: "hero" }, image);
    await updateCampaign(marketing, 3, { active: true });
    // Slot 2 has a photograph but is switched off: it must not appear.
    await setCampaignImage(marketing, 1, { kind: "hero" }, image);

    const live = await getLiveCampaigns();
    expect(live.map((slide) => slide.id)).toEqual(["slide-1", "slide-4"]);
    expect(live[0].heroUrl).toBe("/categories/snacks");
    // Tiles without an image never render as empty cards.
    expect(live[0].showcase).toEqual([
      { imageUrl: "/uploads/file-2.jpg", title: "American Snacks", href: "/categories/snacks" },
    ]);
    expect(live[1].showcase).toEqual([]);
  });

  it("refuses to switch on a slide with no photograph", async () => {
    await expect(updateCampaign(marketing, 2, { active: true })).rejects.toThrow(/hero photograph/);
  });

  it("switches a slide off when its photograph is removed, and deletes the file", async () => {
    await setCampaignImage(marketing, 0, { kind: "hero" }, image);
    await updateCampaign(marketing, 0, { active: true });
    await clearCampaignImage(marketing, 0, { kind: "hero" });
    expect((await getCampaignSettings()).slides[0].active).toBe(false);
    expect(deleted).toEqual(["file-1"]);
    expect(await getLiveCampaigns()).toEqual([]);
  });

  it("deletes the replaced file when a tile image is replaced", async () => {
    await setCampaignImage(marketing, 0, { kind: "tile", tile: 0 }, image);
    await setCampaignImage(marketing, 0, { kind: "tile", tile: 0 }, image);
    expect(deleted).toEqual(["file-1"]);
  });

  it("moves a slide and its tiles together", async () => {
    await setCampaignImage(marketing, 0, { kind: "hero" }, image);
    await updateCampaign(marketing, 0, { name: "Snacks", showcase: [{ title: "Crisps" }] });
    await moveCampaign(marketing, 0, "down");
    const settings = await getCampaignSettings();
    expect(settings.slides[1]).toMatchObject({ name: "Snacks", id: "slide-1" });
    expect(settings.slides[1].showcase[0].title).toBe("Crisps");
    expect(settings.slides[0].name).toBe("");
  });
});

describe("destinations", () => {
  it.each([
    ["/products/mechanical-keyboard", "/products/mechanical-keyboard"],
    ["/categories/electronics?sort=newest", "/categories/electronics?sort=newest"],
    ["https://example.com/sale", "https://example.com/sale"],
    ["", ""],
  ])("accepts %s", (input, expected) => {
    expect(normaliseDestination(input)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "//evil.example", "data:text/html,x", "ftp://x.example", "products", "/a b"])(
    "refuses %s",
    (input) => {
      expect(normaliseDestination(input)).toBeNull();
    },
  );

  it("refuses to save an unsafe link", async () => {
    await expect(updateCampaign(marketing, 0, { heroUrl: "javascript:alert(1)" })).rejects.toThrow();
  });
});

describe("who may change it", () => {
  it("refuses a customer and a role without homepage.manage", async () => {
    await expect(updateCampaign(customer, 0, { name: "x" })).rejects.toThrow();
    await expect(updateCampaign(catalogue, 0, { name: "x" })).rejects.toThrow();
    await expect(setCampaignImage(catalogue, 0, { kind: "hero" }, image)).rejects.toThrow();
    expect(uploads).toBe(0);
  });
});
