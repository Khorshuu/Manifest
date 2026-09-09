/**
 * The homepage hero as stored data.
 *
 * Two things are being protected. The first is that the settings are real —
 * they persist, they come back, and a corrupt row degrades to the defaults
 * rather than taking the front page down. The second is that the hero is not a
 * hole in the permission model: it uploads media and it writes a link the whole
 * shop follows, so who may change it and what they may put in it are checked
 * here rather than trusted to the admin page hiding a button.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, siteSettings, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  HERO_DEFAULTS,
  HERO_SETTING_KEY,
  clearHeroImage,
  getHeroSettings,
  replaceHeroImage,
  updateHeroSettings,
} from "@/lib/homepage";
import { setMediaProviderForTesting } from "@/lib/providers/media";
import type { MediaProvider, StoredMedia, UploadInput } from "@/lib/providers/media";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };

/** A one-pixel PNG, so the provider's own format check has real bytes to read. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Records what was stored and what was deleted, so both can be asserted. */
class RecordingMedia implements MediaProvider {
  readonly name = "recording";
  readonly deleted: string[] = [];
  private count = 0;

  async upload(input: UploadInput): Promise<StoredMedia> {
    this.count += 1;
    const key = `hero-${this.count}.png`;
    return {
      url: `/uploads/${key}`,
      key,
      contentType: "image/png",
      bytes: input.data.length,
    };
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

let media: RecordingMedia;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setMediaProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  media = new RecordingMedia();
  setMediaProviderForTesting(media);

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((row) => row.email === staff.email)!.id;
  customer.id = rows.find((row) => row.email === customer.email)!.id;
});

describe("reading", () => {
  it("returns the built-in words when nothing has been set", async () => {
    expect(await getHeroSettings()).toEqual(HERO_DEFAULTS);
  });

  it("falls back to the defaults rather than throwing on a corrupt row", async () => {
    await harness.db
      .insert(siteSettings)
      .values({ key: HERO_SETTING_KEY, valueJson: { value: { headline: 42 } } });

    expect(await getHeroSettings()).toEqual(HERO_DEFAULTS);
  });
});

describe("writing", () => {
  it("persists what staff typed", async () => {
    await updateHeroSettings(staff, {
      headline: "Landed in Dhaka",
      eyebrow: "",
      contrast: "dark",
      focalX: 20,
    });

    const hero = await getHeroSettings();
    expect(hero.headline).toBe("Landed in Dhaka");
    expect(hero.eyebrow).toBe("");
    expect(hero.contrast).toBe("dark");
    expect(hero.focalX).toBe(20);
    // Untouched fields survive a partial save.
    expect(hero.support).toBe(HERO_DEFAULTS.support);
  });

  it("writes an audit entry carrying the value it replaced", async () => {
    await updateHeroSettings(staff, { headline: "First" });
    await updateHeroSettings(staff, { headline: "Second" });

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, HERO_SETTING_KEY));

    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[1].beforeJson)).toContain("First");
    expect(JSON.stringify(entries[1].afterJson)).toContain("Second");
  });

  it("refuses a customer", async () => {
    await expect(updateHeroSettings(customer, { headline: "Mine" })).rejects.toThrow();
    await expect(replaceHeroImage(customer, {
      data: PNG,
      originalName: "x.png",
      contentType: "image/png",
    })).rejects.toThrow();
    await expect(clearHeroImage(customer)).rejects.toThrow();

    expect(await getHeroSettings()).toEqual(HERO_DEFAULTS);
  });

  it("refuses an anonymous visitor", async () => {
    await expect(updateHeroSettings(null, { headline: "Mine" })).rejects.toThrow();
  });

  /**
   * The call to action is a link an administrator types. A field that becomes
   * an href is how an open redirect gets built by accident.
   */
  it("refuses a call to action that leaves the site", async () => {
    for (const ctaHref of [
      "https://example.com/phish",
      "//example.com/phish",
      "javascript:alert(1)",
    ]) {
      await expect(updateHeroSettings(staff, { ctaHref })).rejects.toThrow();
    }

    expect((await getHeroSettings()).ctaHref).toBe(HERO_DEFAULTS.ctaHref);
  });

  it("accepts an empty destination, meaning the featured product", async () => {
    await updateHeroSettings(staff, { ctaHref: "" });
    expect((await getHeroSettings()).ctaHref).toBe("");
  });
});

describe("the photograph", () => {
  it("stores the file and points the homepage at it", async () => {
    const hero = await replaceHeroImage(staff, {
      data: PNG,
      originalName: "hero.png",
      contentType: "image/png",
    });

    expect(hero.imageUrl).toBe("/uploads/hero-1.png");
    expect((await getHeroSettings()).imageKey).toBe("hero-1.png");
  });

  it("deletes the file it replaced, and only after the new one is stored", async () => {
    await replaceHeroImage(staff, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
    });
    await replaceHeroImage(staff, {
      data: PNG,
      originalName: "two.png",
      contentType: "image/png",
    });

    expect(media.deleted).toEqual(["hero-1.png"]);
    expect((await getHeroSettings()).imageUrl).toBe("/uploads/hero-2.png");
  });

  it("clears back to the catalogue artwork", async () => {
    await replaceHeroImage(staff, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
    });

    const hero = await clearHeroImage(staff);
    expect(hero.imageUrl).toBeNull();
    expect(hero.imageKey).toBeNull();
    expect(media.deleted).toEqual(["hero-1.png"]);
  });

  it("refuses a file that is not an image whatever it claims to be", async () => {
    // The provider establishes the format from the bytes, not the header.
    setMediaProviderForTesting(undefined);

    await expect(
      replaceHeroImage(staff, {
        data: Buffer.from("MZ this is an executable"),
        originalName: "hero.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });
});
