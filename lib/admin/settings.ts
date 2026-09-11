import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff, requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Site settings.
 *
 * Every setting is declared here with a schema and a default, so a missing or
 * corrupt row degrades to a sane value rather than to a crash or, worse, to a
 * silently wrong price. Reading is staff-wide; writing is super_admin only
 * (docs/SECURITY.md).
 */

export const SETTING_DEFINITIONS = {
  "store.contact_email": {
    schema: z.string().email(),
    fallback: "hello@example.com",
    label: "Contact email",
    hint: "Where customer replies go.",
  },
  "preorder.default_deposit_percent": {
    schema: z.number().int().min(1).max(99),
    fallback: 40,
    label: "Default deposit percent",
    hint: "Suggested when a new preorder variant is set to take a deposit.",
  },
  "landed.shipping_per_kg_bdt": {
    schema: z.number().int().min(0).max(100_000_00),
    fallback: 950_00,
    label: "Shipping per kilogram (BDT)",
    hint: "Used to show what part of a landed price is freight. It does not change what anyone is charged.",
  },
  "landed.duty_percent": {
    schema: z.number().int().min(0).max(200),
    fallback: 32,
    label: "Customs duty percent",
    hint: "Applied to the goods value when splitting a landed price. It does not change what anyone is charged.",
  },
  "landed.assumed_weight_grams": {
    schema: z.number().int().min(1).max(100_000),
    fallback: 500,
    label: "Assumed weight when unknown (grams)",
    hint: "Used only for variants with no weight recorded.",
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof SETTING_DEFINITIONS)[K]["schema"]
>;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

/**
 * Reads one setting. Never throws on a bad row: a malformed value falls back
 * to the default, because a settings table someone has edited by hand should
 * not be able to take the storefront down.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
): Promise<SettingValue<K>> {
  const [row] = await db
    .select({ valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, key))
    .limit(1);

  const definition = SETTING_DEFINITIONS[key];
  const parsed = definition.schema.safeParse(
    (row?.valueJson as { value?: unknown } | undefined)?.value,
  );

  return (parsed.success ? parsed.data : definition.fallback) as SettingValue<K>;
}

/** Reads several at once, for a page that needs more than one. */
export async function getSettings<K extends SettingKey>(
  keys: readonly K[],
): Promise<{ [Key in K]: SettingValue<Key> }> {
  const rows =
    keys.length === 0
      ? []
      : await db
          .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
          .from(siteSettings)
          .where(inArray(siteSettings.key, [...keys]));

  const stored = new Map(rows.map((row) => [row.key, row.valueJson]));
  const result = {} as { [Key in K]: SettingValue<Key> };

  for (const key of keys) {
    const definition = SETTING_DEFINITIONS[key];
    const parsed = definition.schema.safeParse(
      (stored.get(key) as { value?: unknown } | undefined)?.value,
    );
    result[key] = (
      parsed.success ? parsed.data : definition.fallback
    ) as SettingValue<typeof key>;
  }

  return result;
}

export type SettingRow = {
  key: SettingKey;
  label: string;
  hint: string;
  value: unknown;
  /** True when nothing is stored and the fallback is in use. */
  isDefault: boolean;
};

export async function listSettings(
  actor: SessionUser | null,
): Promise<SettingRow[]> {
  requireStaff(actor);

  const rows = await db
    .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings);

  const stored = new Map(rows.map((row) => [row.key, row.valueJson]));

  return SETTING_KEYS.map((key) => {
    const definition = SETTING_DEFINITIONS[key];
    const raw = (stored.get(key) as { value?: unknown } | undefined)?.value;
    const parsed = definition.schema.safeParse(raw);

    return {
      key,
      label: definition.label,
      hint: definition.hint,
      value: parsed.success ? parsed.data : definition.fallback,
      isDefault: !parsed.success,
    };
  });
}

export class SettingError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "SettingError";
  }
}

/**
 * Writes one setting. Super admin only, and audited with the previous value —
 * a duty percentage changing is exactly the sort of thing someone will need to
 * explain later.
 */
export async function updateSetting(
  actor: SessionUser | null,
  key: string,
  value: unknown,
) {
  const admin = requirePermission(actor, "settings.manage");

  if (!SETTING_KEYS.includes(key as SettingKey)) {
    throw new SettingError("That is not a setting.");
  }

  const definition = SETTING_DEFINITIONS[key as SettingKey];
  const parsed = definition.schema.safeParse(value);

  if (!parsed.success) {
    throw new SettingError(
      parsed.error.issues[0]?.message ?? "That value is not allowed.",
    );
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, key));

    await tx
      .insert(siteSettings)
      .values({
        key,
        valueJson: { value: parsed.data },
        updatedBy: admin.id,
      })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: {
          valueJson: { value: parsed.data },
          updatedBy: admin.id,
          updatedAt: new Date(),
        },
      });

    await recordAudit(
      {
        actorUserId: admin.id,
        action: "site_settings.updated",
        entityType: "site_setting",
        entityId: key,
        before: before?.valueJson ?? null,
        after: { value: parsed.data },
      },
      tx,
    );

    return { key, value: parsed.data };
  });
}
