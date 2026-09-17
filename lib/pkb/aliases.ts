import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbAliases,
  pkbAttributeOptions,
  type PkbAliasKind,
  type PkbAliasTarget,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission, type Permission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError } from "./common";
import { brandKey, labelKey } from "./normalize";

/**
 * Aliases: other names for a brand, product, variant, family, attribute or
 * option ("XM6" for WH-1000XM6). Suggested by anyone managing the catalogue,
 * approved by the owner of that vocabulary. SearchPulse consumes approved
 * aliases in Stage 5; nothing is learned automatically.
 */

export type AliasTarget = { kind: PkbAliasTarget; id: string };

const TARGET_COLUMN: Record<PkbAliasTarget, keyof typeof pkbAliases.$inferInsert> = {
  brand: "brandId",
  product: "pkbProductId",
  variant: "pkbVariantId",
  family: "familyId",
  definition: "definitionId",
  option: "optionId",
};

/** Vocabulary aliases are knowledge decisions; product and variant aliases change search. */
const APPROVER: Record<PkbAliasTarget, Permission> = {
  brand: "knowledge.manage",
  family: "knowledge.manage",
  definition: "knowledge.manage",
  option: "knowledge.manage",
  product: "search.manage",
  variant: "search.manage",
};

export function aliasKey(target: PkbAliasTarget, alias: string): string {
  return target === "brand" ? brandKey(alias) : labelKey(alias);
}

export async function suggestAlias(
  actor: SessionUser | null,
  input: { target: AliasTarget; alias: string; aliasKind: PkbAliasKind; evidenceNote?: string | null },
) {
  const staff = requirePermission(actor, "catalog.manage");
  const alias = input.alias.trim();
  const normalized = aliasKey(input.target.kind, alias);
  if (!normalized) throw new PkbError("An alias needs letters or digits.");

  const values: typeof pkbAliases.$inferInsert = {
    targetKind: input.target.kind,
    alias: alias.slice(0, 120),
    aliasNormalized: normalized,
    aliasKind: input.aliasKind,
    status: "suggested",
    origin: "MANUAL_ADMIN",
    evidenceNote: input.evidenceNote?.slice(0, 500) ?? null,
    createdBy: staff.id,
  };
  (values as Record<string, unknown>)[TARGET_COLUMN[input.target.kind]] = input.target.id;
  if (input.target.kind === "option") {
    const [option] = await db.select().from(pkbAttributeOptions).where(eq(pkbAttributeOptions.id, input.target.id));
    if (!option) throw new PkbError("That option does not exist.", 404);
    values.definitionId = option.definitionId;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(pkbAliases).values(values).onConflictDoNothing().returning();
    if (!row) throw new PkbError("That alias is already recorded for it.", 409);
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.alias_suggested", entityType: "pkb_alias", entityId: row.id, after: { target: input.target, alias } },
      tx,
    );
    return row;
  });
}

export async function decideAlias(actor: SessionUser | null, aliasId: string, decision: "approved" | "rejected") {
  const [row] = await db.select().from(pkbAliases).where(eq(pkbAliases.id, aliasId));
  if (!row) throw new PkbError("That alias does not exist.", 404);
  const staff = requirePermission(actor, APPROVER[row.targetKind]);
  if (row.status !== "suggested") throw new PkbError(`That alias is already ${row.status}.`, 409);

  return db.transaction(async (tx) => {
    try {
      await tx
        .update(pkbAliases)
        .set({ status: decision, decidedBy: staff.id, decidedAt: new Date() })
        .where(eq(pkbAliases.id, aliasId));
    } catch (error) {
      const text = `${error instanceof Error ? error.message : ""} ${error instanceof Error && error.cause ? String(error.cause) : ""}`;
      if (/pkb_aliases_approved_unique|duplicate key/i.test(text)) {
        throw new PkbError(`“${row.alias}” is already an approved alias of something else.`, 409);
      }
      throw error;
    }
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.alias_decided", entityType: "pkb_alias", entityId: aliasId, after: { decision } },
      tx,
    );
  });
}
