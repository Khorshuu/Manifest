import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { getProductCardBySlug, listProductCards } from "@/lib/catalog";
import { getMediaProvider, type UploadInput } from "@/lib/providers/media";
import {
  HEADER_CONTRAST_MODES,
  getHeroSettings,
  type HeaderContrastMode,
} from "./hero";
import { getShowcaseSettings } from "./showcase";

/**
 * The homepage's promotional campaigns (DECISIONS.md D-035).
 *
 * A campaign is one slide of the homepage: a hero photograph with its own
 * destination and optional words, and the four showcase tiles directly
 * beneath it. The hero and its tiles are one record, so they can only ever
 * change together — there is no way to rotate one without the other.
 *
 * Stored as one row of `site_settings` like the hero and showcase before it,
 * with the audit trail that table already carries. That row replaces the two
 * older keys (`home.hero`, `home.showcase`) as what the storefront reads; the
 * first read converts them, so nothing staff set up is lost.
 *
 * There are always five slots. Only a slot that is switched on *and* has a
 * photograph reaches the storefront, so an unused slot is simply absent from
 * the slider — never a blank slide or an empty card.
 */

export const CAMPAIGNS_SETTING_KEY = "home.campaigns";
export const CAMPAIGN_SLOTS = 5;
export const SHOWCASE_SLOTS = 4;

export { HEADER_CONTRAST_MODES, type HeaderContrastMode };

/**
 * A destination staff may give a hero, a button or a tile.
 *
 * A path on this site ("/categories/audio"), or a full `http(s)` address for
 * somewhere else. Everything else — `javascript:`, `data:`, a
 * protocol-relative "//host", a bare word — is refused, because this value is
 * written straight into an `href` on the public homepage.
 */
export function normaliseDestination(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "";
  if (value.length > 500 || /[\s\\]/.test(value)) return null;

  if (value.startsWith("/")) {
    return value.startsWith("//") ? null : value;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** True for a destination that leaves this site. */
export function isExternalDestination(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

const destination = z
  .string()
  .max(500)
  .transform((value, context) => {
    const clean = normaliseDestination(value);
    if (clean === null) {
      context.addIssue({
        code: "custom",
        message:
          "Use a path on this site, like /categories/audio, or a full https:// address.",
      });
      return z.NEVER;
    }
    return clean;
  });

const imageSchema = z
  .object({
    url: z.string().trim().min(1).max(500),
    /**
     * The media provider's key when the file was uploaded here for the
     * homepage, so a replaced file can be deleted. Null when the image is
     * borrowed — a product photograph carried over from the old showcase —
     * which must never be deleted from under its product.
     */
    key: z.string().trim().max(160).nullable(),
  })
  .nullable();

export type CampaignImage = z.infer<typeof imageSchema>;

const showcaseItemSchema = z.object({
  image: imageSchema,
  title: z.string().trim().max(60),
  url: destination,
  active: z.boolean(),
});

export type ShowcaseItem = z.infer<typeof showcaseItemSchema>;

const campaignSchema = z.object({
  id: z.string().min(1).max(40),
  /** For staff only: what this slide is promoting. Never shown to shoppers. */
  name: z.string().trim().max(80),
  active: z.boolean(),
  image: imageSchema,
  focalX: z.number().min(0).max(100),
  focalY: z.number().min(0).max(100),
  /** Where clicking the photograph goes. Empty: the photograph is not a link. */
  heroUrl: destination,
  /** Open the hero, button and tiles in a new tab. Only honoured off-site. */
  newTab: z.boolean(),
  title: z.string().trim().max(90),
  text: z.string().trim().max(220),
  ctaText: z.string().trim().max(30),
  ctaUrl: destination,
  contrast: z.enum(HEADER_CONTRAST_MODES),
  showcase: z.array(showcaseItemSchema).length(SHOWCASE_SLOTS),
});

export type Campaign = z.infer<typeof campaignSchema>;

const campaignsSchema = z.object({
  slides: z.array(campaignSchema).length(CAMPAIGN_SLOTS),
});

export type CampaignSettings = z.infer<typeof campaignsSchema>;

function emptyShowcaseItem(): ShowcaseItem {
  return { image: null, title: "", url: "", active: true };
}

function emptyCampaign(index: number): Campaign {
  return {
    id: `slide-${index + 1}`,
    name: "",
    active: false,
    image: null,
    focalX: 50,
    focalY: 50,
    heroUrl: "",
    newTab: false,
    title: "",
    text: "",
    ctaText: "",
    ctaUrl: "",
    contrast: "auto",
    showcase: Array.from({ length: SHOWCASE_SLOTS }, emptyShowcaseItem),
  };
}

export function emptyCampaigns(): CampaignSettings {
  return {
    slides: Array.from({ length: CAMPAIGN_SLOTS }, (_, index) =>
      emptyCampaign(index),
    ),
  };
}

/**
 * The first slide, built from what staff had already set up under the single
 * hero and the product showcase: the same photograph, focal point and header
 * mode, and the chosen products as tiles showing each product's own photograph
 * and name. Borrowed photographs carry no key, so they are never deleted.
 */
async function convertLegacy(): Promise<CampaignSettings> {
  const [hero, showcase] = await Promise.all([
    getHeroSettings(),
    getShowcaseSettings(),
  ]);

  const settings = emptyCampaigns();
  if (!hero.imageUrl) return settings;

  const curated = (
    await Promise.all(
      showcase.slugs
        .slice(0, SHOWCASE_SLOTS)
        .map((slug) => getProductCardBySlug(slug)),
    )
  ).filter((card): card is NonNullable<typeof card> => card !== null);

  // A shop that never curated the old row still opens with four tiles: the
  // newest listings with a photograph fill whatever staff did not choose.
  const newest = curated.length < SHOWCASE_SLOTS
    ? await listProductCards({ sort: "newest", limit: 12 })
    : [];
  const cards = [...curated, ...newest]
    .filter(
      (card, position, all) =>
        card.imageUrl && all.findIndex((other) => other.slug === card.slug) === position,
    )
    .slice(0, SHOWCASE_SLOTS);

  settings.slides[0] = {
    ...settings.slides[0],
    name: "Main campaign",
    active: true,
    image: { url: hero.imageUrl, key: hero.imageKey },
    focalX: hero.focalX,
    focalY: hero.focalY,
    contrast: hero.contrast,
    showcase: settings.slides[0].showcase.map((item, index) => {
      const card = cards[index];
      if (!card?.imageUrl) return item;
      return {
        image: { url: card.imageUrl, key: null },
        title: card.title.slice(0, 60),
        url: `/products/${card.slug}`,
        active: true,
      };
    }),
  };

  return settings;
}

/**
 * Reads all five slots. Never throws: a stored value that no longer parses
 * degrades to empty slots, because the front page must render.
 */
export async function getCampaignSettings(): Promise<CampaignSettings> {
  const [row] = await db
    .select({ valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, CAMPAIGNS_SETTING_KEY))
    .limit(1);

  if (!row) return convertLegacy();

  const parsed = campaignsSchema.safeParse(
    (row.valueJson as { value?: unknown } | undefined)?.value,
  );

  return parsed.success ? parsed.data : emptyCampaigns();
}

/** One slide as the storefront draws it. */
export type LiveCampaign = {
  id: string;
  imageUrl: string;
  focalX: number;
  focalY: number;
  heroUrl: string | null;
  /** Only ever true for an off-site destination. */
  newTab: boolean;
  title: string | null;
  text: string | null;
  cta: { label: string; href: string } | null;
  contrast: HeaderContrastMode;
  showcase: { imageUrl: string; title: string | null; href: string | null }[];
};

/**
 * What the slider shows: switched-on slots with a photograph, in slot order,
 * each carrying only its switched-on tiles that have an image. A slot that
 * fails either test does not exist as far as a shopper can tell.
 */
export function toLiveCampaigns(settings: CampaignSettings): LiveCampaign[] {
  return settings.slides
    .filter((slide) => slide.active && slide.image)
    .map((slide) => ({
      id: slide.id,
      imageUrl: slide.image!.url,
      focalX: slide.focalX,
      focalY: slide.focalY,
      heroUrl: slide.heroUrl || null,
      newTab: slide.newTab,
      title: slide.title || null,
      text: slide.text || null,
      cta:
        slide.ctaText && (slide.ctaUrl || slide.heroUrl)
          ? { label: slide.ctaText, href: slide.ctaUrl || slide.heroUrl }
          : null,
      contrast: slide.contrast,
      showcase: slide.showcase
        .filter((item) => item.active && item.image)
        .map((item) => ({
          imageUrl: item.image!.url,
          title: item.title || null,
          href: item.url || null,
        })),
    }));
}

export async function getLiveCampaigns(): Promise<LiveCampaign[]> {
  return toLiveCampaigns(await getCampaignSettings());
}

export class CampaignError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "CampaignError";
  }
}

async function writeCampaigns(
  actor: SessionUser,
  next: CampaignSettings,
): Promise<CampaignSettings> {
  // Re-validated on the way in, so nothing unparseable can be stored and
  // later silently discarded by the reader.
  const value = campaignsSchema.parse(next);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, CAMPAIGNS_SETTING_KEY));

    await tx
      .insert(siteSettings)
      .values({
        key: CAMPAIGNS_SETTING_KEY,
        valueJson: { value },
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson: { value }, updatedBy: actor.id, updatedAt: new Date() },
      });

    await recordAudit(
      {
        actorUserId: actor.id,
        action: "site_settings.updated",
        entityType: "site_setting",
        entityId: CAMPAIGNS_SETTING_KEY,
        before: before?.valueJson ?? null,
        after: { value },
      },
      tx,
    );

    return value;
  });
}

function slotIndex(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= CAMPAIGN_SLOTS) {
    throw new CampaignError("That slide does not exist.");
  }
  return slot;
}

function tileIndex(tile: number): number {
  if (!Number.isInteger(tile) || tile < 0 || tile >= SHOWCASE_SLOTS) {
    throw new CampaignError("That showcase tile does not exist.");
  }
  return tile;
}

export const campaignPatchSchema = z
  .object({
    name: campaignSchema.shape.name,
    active: z.boolean(),
    focalX: campaignSchema.shape.focalX,
    focalY: campaignSchema.shape.focalY,
    heroUrl: destination,
    newTab: z.boolean(),
    title: campaignSchema.shape.title,
    text: campaignSchema.shape.text,
    ctaText: campaignSchema.shape.ctaText,
    ctaUrl: destination,
    contrast: z.enum(HEADER_CONTRAST_MODES),
    showcase: z
      .array(
        z
          .object({
            title: showcaseItemSchema.shape.title,
            url: destination,
            active: z.boolean(),
          })
          .partial(),
      )
      .max(SHOWCASE_SLOTS),
  })
  .partial()
  .strict();

/**
 * Saves the words, links, focal point, header mode and switches of one slide.
 * Images arrive separately, as uploads. Refuses to switch on a slide or a tile
 * that has no photograph, which is what keeps blank slides off the homepage.
 */
export async function updateCampaign(
  actor: SessionUser | null,
  slot: number,
  patch: unknown,
): Promise<CampaignSettings> {
  const staff = requirePermission(actor, "homepage.manage");
  const index = slotIndex(slot);

  const parsed = campaignPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new CampaignError(parsed.error.issues[0]?.message ?? "Check the values.");
  }

  const current = await getCampaignSettings();
  const slide = current.slides[index];
  const { showcase: tilePatches, ...fields } = parsed.data;

  const showcase = slide.showcase.map((item, tile) => {
    const next = { ...item, ...(tilePatches?.[tile] ?? {}) };
    // Only refuse the act of switching a tile on without an image. An empty
    // tile that is already "on" is simply not shown, and saving the slide's
    // words must not fail because of it.
    if (!item.active && next.active && !next.image) {
      throw new CampaignError(
        `Upload an image for tile ${tile + 1} before switching it on.`,
      );
    }
    return next;
  });

  const next: Campaign = { ...slide, ...fields, showcase };
  if (next.active && !next.image) {
    throw new CampaignError(
      "Upload a hero photograph before switching this slide on.",
    );
  }

  const slides = [...current.slides];
  slides[index] = next;
  return writeCampaigns(staff, { slides });
}

/** Moves a slide one place earlier or later in the slider. */
export async function moveCampaign(
  actor: SessionUser | null,
  slot: number,
  direction: "up" | "down",
): Promise<CampaignSettings> {
  const staff = requirePermission(actor, "homepage.manage");
  const index = slotIndex(slot);
  const target = direction === "up" ? index - 1 : index + 1;

  const current = await getCampaignSettings();
  if (target < 0 || target >= CAMPAIGN_SLOTS) return current;

  const slides = [...current.slides];
  [slides[index], slides[target]] = [slides[target], slides[index]];
  return writeCampaigns(staff, { slides });
}

export type ImageTarget = { kind: "hero" } | { kind: "tile"; tile: number };

function readImage(slide: Campaign, target: ImageTarget): CampaignImage {
  return target.kind === "hero" ? slide.image : slide.showcase[tileIndex(target.tile)].image;
}

function withImage(slide: Campaign, target: ImageTarget, image: CampaignImage): Campaign {
  if (target.kind === "hero") {
    // A slide cannot stay live without its photograph.
    return { ...slide, image, active: image ? slide.active : false };
  }
  const tile = tileIndex(target.tile);
  return {
    ...slide,
    showcase: slide.showcase.map((item, index) =>
      index === tile ? { ...item, image } : item,
    ),
  };
}

/** Deletes a file this module uploaded, once nothing points at it. */
async function releaseImage(image: CampaignImage, settings: CampaignSettings) {
  if (!image?.key) return;
  const stillUsed = settings.slides.some(
    (slide) =>
      slide.image?.key === image.key ||
      slide.showcase.some((item) => item.image?.key === image.key),
  );
  if (stillUsed) return;
  await getMediaProvider()
    .delete(image.key)
    .catch(() => undefined);
}

/**
 * Stores a new hero or tile image. Uploaded bytes only — never a URL — so the
 * homepage cannot be pointed at an address off this site. The file it
 * replaces is deleted after the new record is committed.
 */
export async function setCampaignImage(
  actor: SessionUser | null,
  slot: number,
  target: ImageTarget,
  input: UploadInput,
): Promise<CampaignSettings> {
  const staff = requirePermission(actor, "homepage.manage");
  const index = slotIndex(slot);
  if (target.kind === "tile") tileIndex(target.tile);

  const current = await getCampaignSettings();
  const previous = readImage(current.slides[index], target);

  // Size and format are established by the provider from the bytes.
  const stored = await getMediaProvider().upload(input);

  const slides = [...current.slides];
  slides[index] = withImage(slides[index], target, { url: stored.url, key: stored.key });
  const next = await writeCampaigns(staff, { slides });

  await releaseImage(previous, next);
  return next;
}

/** Removes a hero or tile image. Removing a hero switches its slide off. */
export async function clearCampaignImage(
  actor: SessionUser | null,
  slot: number,
  target: ImageTarget,
): Promise<CampaignSettings> {
  const staff = requirePermission(actor, "homepage.manage");
  const index = slotIndex(slot);

  const current = await getCampaignSettings();
  const previous = readImage(current.slides[index], target);

  const slides = [...current.slides];
  slides[index] = withImage(slides[index], target, null);
  const next = await writeCampaigns(staff, { slides });

  await releaseImage(previous, next);
  return next;
}
