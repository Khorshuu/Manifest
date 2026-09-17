import { and, eq, sql } from "drizzle-orm";
import {
  pkbAliases,
  pkbBrands,
  pkbFactHistory,
  pkbFacts,
  pkbSources,
  type PkbHistoryChange,
  type PkbOrigin,
  type PkbValueStatus,
  type PkbVerificationState,
} from "@/db/schema";
import { canonicalNumber } from "./decimal";
import type { Attribution, Executor } from "./common";
import { brandKey, cleanText, EMPTY_TYPED, normalizeValue, slugFromName, type TypedValue } from "./normalize";
import type { DefinitionRecord } from "./vocabulary";

/**
 * Low-level fact storage: value columns, provenance, history, brands. Every
 * write to `pkb_facts` goes through `insertFact`, `updateFact` or
 * `deleteFact`, so every change leaves a history row.
 */

export type FactRow = typeof pkbFacts.$inferSelect;

export type FactValue = {
  valueStatus: PkbValueStatus;
  rawValue: string | null;
  rawUnit: string | null;
  rawLabel: string | null;
  typed: TypedValue;
  /** Resolved brand for brand-typed values. */
  brandId: string | null;
  /** Why a value could not be normalized, for reports. */
  failure: string | null;
};

export type Provenance = {
  verificationState: PkbVerificationState;
  origin: PkbOrigin;
  sourceId: string;
  claimId: string | null;
  decidedBy: string | null;
  decisionPolicy: string | null;
};

export type Slot = {
  pkbProductId: string;
  pkbVariantId: string | null;
  definitionId: string;
  ordinal: number;
};

export function slotKey(slot: { pkbVariantId: string | null; definitionId: string; ordinal: number }): string {
  return `${slot.pkbVariantId ?? "-"}|${slot.definitionId}|${slot.ordinal}`;
}

/** Reads a written value for a definition. Brand ids are resolved separately. */
export function readValue(
  definition: DefinitionRecord,
  raw: string,
  context: { rawLabel?: string | null; defaultUnit?: string | null } = {},
): FactValue {
  const rawValue = cleanText(raw);
  const result = normalizeValue(
    {
      dataType: definition.dataType,
      unitDimension: definition.unitDimension,
      options: definition.options.filter((option) => option.status !== "retired"),
    },
    rawValue,
    { defaultUnit: context.defaultUnit },
  );
  return result.status === "normalized"
    ? {
        valueStatus: "normalized",
        rawValue,
        rawUnit: null,
        rawLabel: context.rawLabel ?? null,
        typed: result.value,
        brandId: null,
        failure: null,
      }
    : {
        valueStatus: "unnormalized",
        rawValue,
        rawUnit: null,
        rawLabel: context.rawLabel ?? null,
        typed: EMPTY_TYPED,
        brandId: null,
        failure: result.reason,
      };
}

export function notApplicableValue(): FactValue {
  return {
    valueStatus: "not_applicable",
    rawValue: null,
    rawUnit: null,
    rawLabel: null,
    typed: EMPTY_TYPED,
    brandId: null,
    failure: null,
  };
}

export function valueColumns(value: FactValue) {
  return {
    valueStatus: value.valueStatus,
    rawValue: value.rawValue,
    rawUnit: value.rawUnit,
    rawLabel: value.rawLabel,
    valueText: value.typed.text,
    valueNumber: value.typed.number,
    valueNumberMax: value.typed.numberMax,
    valueUnit: value.typed.unit,
    valueBoolean: value.typed.boolean,
    valueDate: value.typed.date,
    valueOptionId: value.typed.optionId,
    valueBrandId: value.brandId,
  };
}

/** Whether a stored fact already holds this value (raw text aside). */
export function sameStoredValue(row: FactRow, value: FactValue): boolean {
  return (
    row.valueStatus === value.valueStatus &&
    (row.valueText ?? null) === (value.typed.text ?? null) &&
    canonicalNumber(row.valueNumber) === canonicalNumber(value.typed.number) &&
    canonicalNumber(row.valueNumberMax) === canonicalNumber(value.typed.numberMax) &&
    (row.valueUnit ?? null) === (value.typed.unit ?? null) &&
    (row.valueBoolean ?? null) === (value.typed.boolean ?? null) &&
    (row.valueDate ?? null) === (value.typed.date ?? null) &&
    (row.valueOptionId ?? null) === (value.typed.optionId ?? null) &&
    (row.valueBrandId ?? null) === (value.brandId ?? null) &&
    // Two values nobody could read are the same only if they say the same thing.
    (value.valueStatus !== "unnormalized" || row.rawValue === value.rawValue)
  );
}

function snapshot(row: FactRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

async function writeHistory(
  executor: Executor,
  kind: PkbHistoryChange,
  before: FactRow | null,
  after: FactRow | null,
  actorId: string | null,
  reason: string,
) {
  const row = (after ?? before)!;
  await executor.insert(pkbFactHistory).values({
    factId: row.id,
    pkbProductId: row.pkbProductId,
    pkbVariantId: row.pkbVariantId,
    definitionId: row.definitionId,
    changeKind: kind,
    before: before ? snapshot(before) : null,
    after: after ? snapshot(after) : null,
    actorUserId: actorId,
    reason: reason.slice(0, 300),
  });
}

export async function insertFact(
  executor: Executor,
  slot: Slot,
  value: FactValue,
  provenance: Provenance,
  options: { legacyRef: string | null; actorId: string | null; reason: string; locked?: { at: Date; by: string } | null },
): Promise<FactRow> {
  const [row] = await executor
    .insert(pkbFacts)
    .values({
      ...slot,
      ...valueColumns(value),
      ...provenance,
      legacyRef: options.legacyRef,
      lockedAt: options.locked?.at ?? null,
      lockedBy: options.locked?.by ?? null,
    })
    .returning();
  await writeHistory(executor, "created", null, row, options.actorId, options.reason);
  return row;
}

export async function updateFact(
  executor: Executor,
  before: FactRow,
  patch: Partial<FactRow>,
  options: { actorId: string | null; reason: string; kind?: PkbHistoryChange },
): Promise<FactRow> {
  const [row] = await executor
    .update(pkbFacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pkbFacts.id, before.id))
    .returning();
  await writeHistory(executor, options.kind ?? "updated", before, row, options.actorId, options.reason);
  return row;
}

export async function deleteFact(
  executor: Executor,
  before: FactRow,
  options: { actorId: string | null; reason: string },
): Promise<void> {
  await writeHistory(executor, "cleared", before, null, options.actorId, options.reason);
  await executor.delete(pkbFacts).where(eq(pkbFacts.id, before.id));
}

// ------------------------------------------------------------------ brands

/** The brand a written name is, by its key or an approved alias. */
export async function findBrandId(executor: Executor, name: string): Promise<string | null> {
  const key = brandKey(name);
  if (!key) return null;
  const [direct] = await executor.select({ id: pkbBrands.id }).from(pkbBrands).where(eq(pkbBrands.nameNormalized, key));
  if (direct) return direct.id;
  const [aliased] = await executor
    .select({ id: pkbAliases.brandId })
    .from(pkbAliases)
    .where(and(eq(pkbAliases.targetKind, "brand"), eq(pkbAliases.status, "approved"), eq(pkbAliases.aliasNormalized, key)));
  return aliased?.id ?? null;
}

/**
 * The brand a name is, created as `suggested` when nobody has recorded it.
 * Never matched loosely: "Northlake Audio" and "Northline Audio" stay two
 * brands until someone with `knowledge.manage` merges them (A-2).
 */
export async function ensureBrand(executor: Executor, name: string, attribution: Attribution): Promise<string> {
  const existing = await findBrandId(executor, name);
  if (existing) return existing;
  const clean = cleanText(name).slice(0, 120);
  const key = brandKey(clean);
  const base = slugFromName(clean);
  const [taken]: { n: number }[] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(pkbBrands)
    .where(sql`${pkbBrands.slug} = ${base} or ${pkbBrands.slug} like ${`${base}-%`}`);
  const slug = Number(taken?.n ?? 0) === 0 ? base : `${base}-${Number(taken.n) + 1}`;
  await executor
    .insert(pkbBrands)
    .values({
      name: clean,
      nameNormalized: key,
      slug,
      status: "suggested",
      origin: attribution.kind === "legacy" ? "UNKNOWN_LEGACY" : "MANUAL_ADMIN",
      createdBy: attribution.kind === "legacy" ? null : attribution.actorId,
    })
    .onConflictDoNothing();
  return (await findBrandId(executor, clean))!;
}

/**
 * Removes suggested brands nothing refers to any more — a typo corrected in
 * the editor should not leave a brand behind. Approved brands are kept.
 */
export async function pruneUnusedBrands(executor: Executor, brandIds: string[]): Promise<void> {
  const ids = [...new Set(brandIds.filter(Boolean))];
  if (ids.length === 0) return;
  await executor.execute(sql`
    delete from pkb_brands b
    where b.id = any(${`{${ids.join(",")}}`}::uuid[])
      and b.status = 'suggested'
      and not exists (select 1 from pkb_facts f where f.value_brand_id = b.id)
      and not exists (select 1 from pkb_claims c where c.value_brand_id = b.id)
      and not exists (select 1 from pkb_aliases a where a.brand_id = b.id)
  `);
}

// ------------------------------------------------------------------ sources

/** One source row for the knowledge a staff member entered in one save. */
export async function createStaffEntrySource(executor: Executor, actorId: string, title: string): Promise<string> {
  const [row] = await executor
    .insert(pkbSources)
    .values({
      sourceType: "staff_entry",
      acquisitionMethod: "staff_entry",
      origin: "MANUAL_ADMIN",
      usageRights: "unknown",
      title,
      retrievedAt: new Date(),
      createdBy: actorId,
    })
    .returning({ id: pkbSources.id });
  return row.id;
}
