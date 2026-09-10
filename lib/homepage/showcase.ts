import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * The four products directly beneath the hero.
 *
 * Staff choose them by name and by order, and that choice is stored the same
 * way the hero is: one row in `site_settings`, written by staff, read by the
 * storefront with no session. The alternative — a `featured` flag on the
 * product — was rejected because the order matters here and a boolean cannot
 * carry it, and because a shop with a hundred products would then have the
 * homepage's composition spread across a hundred rows.
 *
 * Products are held by slug rather than by id so the stored value stays
 * readable in the settings table and in the audit log, and so a row pointing
 * at a deleted product resolves to nothing rather than to a broken link. The
 * storefront looks each one up through the public predicate, so a product that
 * is unpublished after being chosen simply drops out of the row.
 */

export const SHOWCASE_SETTING_KEY = "home.showcase";

/** Four across a wide screen. Six is the ceiling; the rest scroll. */
export const SHOWCASE_TARGET = 4;
export const SHOWCASE_MAX = 6;

export const showcaseSettingsSchema = z.object({
  slugs: z.array(z.string().trim().min(1).max(160)).max(SHOWCASE_MAX),
});

export type ShowcaseSettings = z.infer<typeof showcaseSettingsSchema>;

/** Empty means "decide from the catalogue" — see the homepage. */
export const SHOWCASE_DEFAULTS: ShowcaseSettings = { slugs: [] };

export async function getShowcaseSettings(): Promise<ShowcaseSettings> {
  const [row] = await db
    .select({ valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, SHOWCASE_SETTING_KEY))
    .limit(1);

  const parsed = showcaseSettingsSchema.safeParse(
    (row?.valueJson as { value?: unknown } | undefined)?.value,
  );

  return parsed.success ? parsed.data : SHOWCASE_DEFAULTS;
}

export class ShowcaseError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ShowcaseError";
  }
}

async function writeShowcase(
  actor: SessionUser,
  next: ShowcaseSettings,
): Promise<ShowcaseSettings> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, SHOWCASE_SETTING_KEY));

    await tx
      .insert(siteSettings)
      .values({
        key: SHOWCASE_SETTING_KEY,
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
        entityId: SHOWCASE_SETTING_KEY,
        before: before?.valueJson ?? null,
        after: { value: next },
      },
      tx,
    );

    return next;
  });
}

/** Duplicates are dropped rather than refused: the row is a set, in order. */
function tidy(slugs: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const slug of slugs) {
    const trimmed = slug.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }

  return kept.slice(0, SHOWCASE_MAX);
}

/** Replaces the whole row — used by the admin list, which owns the order. */
export async function setShowcase(
  actor: SessionUser | null,
  slugs: unknown,
): Promise<ShowcaseSettings> {
  const staff = requireStaff(actor);

  /*
   * Validated as a list of slugs, then trimmed to the ceiling rather than
   * refused for being over it. A whole-row save is staff saying "this is the
   * row"; dropping the overflow keeps the front page working, where an error
   * would leave whatever was there before with no clue why.
   */
  const parsed = z
    .array(z.string().trim().min(1).max(160))
    .safeParse(slugs);

  if (!parsed.success) {
    throw new ShowcaseError("That is not a list of products.");
  }

  return writeShowcase(staff, { slugs: tidy(parsed.data) });
}

/**
 * One product, added from wherever staff are already standing — the product
 * page in the admin, rather than a trip to the homepage settings.
 */
export async function addToShowcase(
  actor: SessionUser | null,
  slug: string,
): Promise<ShowcaseSettings> {
  const staff = requireStaff(actor);
  const current = await getShowcaseSettings();

  if (current.slugs.includes(slug)) return current;
  if (current.slugs.length >= SHOWCASE_MAX) {
    throw new ShowcaseError(
      `The showcase holds ${SHOWCASE_MAX} products. Remove one first.`,
    );
  }

  return writeShowcase(staff, { slugs: tidy([...current.slugs, slug]) });
}

export async function removeFromShowcase(
  actor: SessionUser | null,
  slug: string,
): Promise<ShowcaseSettings> {
  const staff = requireStaff(actor);
  const current = await getShowcaseSettings();

  return writeShowcase(staff, {
    slugs: current.slugs.filter((entry) => entry !== slug),
  });
}

/** Moves one product along the row, for the admin's up and down controls. */
export async function moveInShowcase(
  actor: SessionUser | null,
  slug: string,
  direction: "up" | "down",
): Promise<ShowcaseSettings> {
  const staff = requireStaff(actor);
  const current = await getShowcaseSettings();

  const index = current.slugs.indexOf(slug);
  if (index === -1) throw new ShowcaseError("That product is not in the row.");

  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= current.slugs.length) return current;

  const slugs = [...current.slugs];
  [slugs[index], slugs[target]] = [slugs[target], slugs[index]];

  return writeShowcase(staff, { slugs });
}
