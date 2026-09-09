import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { getMediaProvider, type UploadInput } from "@/lib/providers/media";

/**
 * The homepage hero, as something staff own rather than something in the
 * source.
 *
 * It is stored as one row in `site_settings` — the table that already exists
 * for exactly this, with the audit trail and the staff gate that come with it.
 * There is deliberately no second settings table and no new store: the hero is
 * configuration, and the shop already has a place for configuration.
 *
 * Reading is public, because the storefront's first screen is public. Writing
 * needs a staff session, which is the same bar as uploading product media
 * (CLAUDE.md §7) — a hero photograph is a listing photograph in every way that
 * matters. `site_settings` writes elsewhere are super-admin only because those
 * settings decide money; this one decides a picture, so the gate is staff.
 */

export const HERO_SETTING_KEY = "home.hero";

/**
 * How the header over the hero is coloured.
 *
 * `auto` measures the photograph in the browser and takes the opposite
 * treatment. The other two are stated by whoever chose the photograph, and
 * they name **the lettering**, not the picture: `light` is pale lettering for
 * a dark photograph, `dark` is navy lettering for a bright one. That is the
 * way round an editor thinks about it — they are looking at the header, not at
 * a luminance average.
 */
export const HEADER_CONTRAST_MODES = ["auto", "light", "dark"] as const;
export type HeaderContrastMode = (typeof HEADER_CONTRAST_MODES)[number];

/**
 * An internal destination only.
 *
 * The call to action is a link an administrator types, and a text field that
 * becomes an `href` is how an open redirect gets built by accident. Only a
 * path on this site is accepted — never a scheme, a host, or a protocol
 * relative `//elsewhere`.
 */
const internalPath = z
  .string()
  .trim()
  .max(200)
  .refine(
    // Empty means "the featured product's own page", which is the right
    // destination often enough to be the default.
    (value) => value === "" || (value.startsWith("/") && !value.startsWith("//")),
    "The link must be a path on this site, starting with /.",
  );

export const heroSettingsSchema = z.object({
  /** Where the photograph is served from. Null falls back to catalogue art. */
  imageUrl: z.string().trim().max(500).nullable(),
  /** The media provider's own key, so a replaced photograph can be deleted. */
  imageKey: z.string().trim().max(160).nullable(),
  /** Focal point as a percentage, fed straight to `object-position`. */
  focalX: z.number().min(0).max(100),
  focalY: z.number().min(0).max(100),
  contrast: z.enum(HEADER_CONTRAST_MODES),
  eyebrow: z.string().trim().max(80),
  headline: z.string().trim().min(1).max(120),
  support: z.string().trim().max(280),
  ctaLabel: z.string().trim().min(1).max(40),
  ctaHref: internalPath,
  /**
   * The product the hero prices. Null means "whichever batch closes soonest",
   * which is the honest default: it never advertises a product that has gone.
   */
  featuredSlug: z.string().trim().max(160).nullable(),
});

export type HeroSettings = z.infer<typeof heroSettingsSchema>;

/**
 * What the homepage says before anyone has changed anything.
 *
 * These are the words the hero shipped with, kept here rather than in the
 * component so that "reset to default" and "never configured" are the same
 * code path.
 */
export const HERO_DEFAULTS: HeroSettings = {
  imageUrl: null,
  imageKey: null,
  focalX: 50,
  focalY: 50,
  contrast: "auto",
  eyebrow: "Ordering is open for this batch",
  headline: "American goods, landed in Bangladesh",
  support:
    "One fixed price with shipping and customs duty already inside it. Every listing says when the window closes and when it arrives.",
  ctaLabel: "Preorder this",
  /** Empty: the featured product's own page. */
  ctaHref: "",
  featuredSlug: null,
};

/**
 * Reads the hero. Never throws: a row someone has edited by hand degrades to
 * the defaults, because the front page of the shop must render.
 */
export async function getHeroSettings(): Promise<HeroSettings> {
  const [row] = await db
    .select({ valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, HERO_SETTING_KEY))
    .limit(1);

  const parsed = heroSettingsSchema.safeParse(
    (row?.valueJson as { value?: unknown } | undefined)?.value,
  );

  return parsed.success ? parsed.data : HERO_DEFAULTS;
}

export class HeroSettingsError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "HeroSettingsError";
  }
}

/** Writes the whole record and audits what it replaced. Staff only. */
async function writeHero(
  actor: SessionUser,
  next: HeroSettings,
): Promise<HeroSettings> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, HERO_SETTING_KEY));

    await tx
      .insert(siteSettings)
      .values({
        key: HERO_SETTING_KEY,
        valueJson: { value: next },
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: {
          valueJson: { value: next },
          updatedBy: actor.id,
          updatedAt: new Date(),
        },
      });

    await recordAudit(
      {
        actorUserId: actor.id,
        action: "site_settings.updated",
        entityType: "site_setting",
        entityId: HERO_SETTING_KEY,
        before: before?.valueJson ?? null,
        after: { value: next },
      },
      tx,
    );

    return next;
  });
}

/**
 * Updates the words, the focal point and the contrast mode. The photograph has
 * its own function below, because it arrives as bytes rather than as JSON.
 */
export async function updateHeroSettings(
  actor: SessionUser | null,
  patch: unknown,
): Promise<HeroSettings> {
  const staff = requireStaff(actor);

  const current = await getHeroSettings();
  // Only the fields an editor may type. The image pair is set by uploading or
  // clearing a photograph, never by posting a URL — otherwise the hero becomes
  // a way to point the front page at any address on the internet.
  const parsed = heroSettingsSchema
    .omit({ imageUrl: true, imageKey: true })
    .partial()
    .safeParse(patch);

  if (!parsed.success) {
    throw new HeroSettingsError(
      parsed.error.issues[0]?.message ?? "Check the values.",
    );
  }

  return writeHero(staff, { ...current, ...parsed.data });
}

/**
 * Stores a new hero photograph and points the homepage at it.
 *
 * The previous file is deleted after the new record is committed, so a failed
 * write can never leave the page pointing at bytes that are gone.
 */
export async function replaceHeroImage(
  actor: SessionUser | null,
  input: UploadInput,
): Promise<HeroSettings> {
  const staff = requireStaff(actor);

  const current = await getHeroSettings();
  const media = getMediaProvider();
  // Validation lives in the provider: size, and the format established from
  // the file's own bytes rather than from what the browser claimed.
  const stored = await media.upload(input);

  const next = await writeHero(staff, {
    ...current,
    imageUrl: stored.url,
    imageKey: stored.key,
  });

  if (current.imageKey && current.imageKey !== stored.key) {
    await media.delete(current.imageKey).catch(() => undefined);
  }

  return next;
}

/** Removes the photograph; the hero falls back to the featured product's art. */
export async function clearHeroImage(
  actor: SessionUser | null,
): Promise<HeroSettings> {
  const staff = requireStaff(actor);

  const current = await getHeroSettings();
  const next = await writeHero(staff, {
    ...current,
    imageUrl: null,
    imageKey: null,
  });

  if (current.imageKey) {
    await getMediaProvider()
      .delete(current.imageKey)
      .catch(() => undefined);
  }

  return next;
}
