import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  pkbAliases,
  pkbAttributeDefinitions,
  pkbAttributeOptions,
  pkbSources,
  type PkbReviewStatus,
} from "@/db/schema";
import type { Executor } from "./common";
import { labelKey, type AttributeDataType } from "./normalize";
import { ensureDefaultPolicies } from "./policies";

/**
 * The attribute vocabulary: the system definitions every product can carry,
 * lookups, and label matching (D-062, D-064).
 *
 * System definitions are Manifest's own schema — the identity attributes and
 * the fixed "advanced details" the listing editor has always asked for. Every
 * other definition is data: mirrored from a category's specifications, or
 * created by staff.
 */

export type SystemDefinition = {
  key: string;
  label: string;
  dataType: AttributeDataType;
  cardinality?: "single" | "multiple";
  unitDimension?: string;
  displayUnit?: string;
  searchable?: boolean;
  filterable?: boolean;
  seoRelevant?: boolean;
  structuredDataProperty?: string;
  /** Other labels that name exactly this attribute (spelling variants only). */
  aliases?: string[];
};

export const SYSTEM_DEFINITIONS: SystemDefinition[] = [
  { key: "brand", label: "Brand", dataType: "brand", searchable: true, filterable: true, seoRelevant: true, structuredDataProperty: "brand" },
  { key: "manufacturer", label: "Manufacturer", dataType: "text", searchable: true, seoRelevant: true, structuredDataProperty: "manufacturer" },
  { key: "model_name", label: "Model", dataType: "text", searchable: true, seoRelevant: true, structuredDataProperty: "model", aliases: ["Model name"] },
  { key: "generation", label: "Generation", dataType: "text", searchable: true, seoRelevant: true },
  { key: "product_type", label: "Product type", dataType: "text", searchable: true, seoRelevant: true },
  { key: "release_date", label: "Released", dataType: "date", structuredDataProperty: "releaseDate", aliases: ["Release date"] },
  { key: "unit_count", label: "Unit count", dataType: "number" },
  { key: "unit_type", label: "Unit type", dataType: "text" },
  { key: "material", label: "Material", dataType: "text", searchable: true, filterable: true, seoRelevant: true, structuredDataProperty: "material" },
  { key: "color", label: "Colour", dataType: "text", searchable: true, filterable: true, seoRelevant: true, structuredDataProperty: "color", aliases: ["Color"] },
  { key: "size", label: "Size", dataType: "text", searchable: true, filterable: true, structuredDataProperty: "size" },
  // Kept as text: "10 x 5 x 3 cm" does not say which side is the width, and
  // assigning axes would be a guess (docs/KNOWLEDGE_PLATFORM.md, normalization gaps).
  { key: "dimensions", label: "Product dimensions", dataType: "text" },
  { key: "item_weight", label: "Item weight", dataType: "quantity", unitDimension: "mass", displayUnit: "g", seoRelevant: true, structuredDataProperty: "weight" },
  { key: "package_dimensions", label: "Package dimensions", dataType: "text" },
  { key: "package_weight", label: "Package weight", dataType: "quantity", unitDimension: "mass", displayUnit: "g" },
  { key: "compatibility_notes", label: "Compatibility", dataType: "text", searchable: true },
  { key: "special_features", label: "Special features", dataType: "text", searchable: true },
  { key: "intended_use", label: "Intended use", dataType: "text", searchable: true },
  { key: "care_instructions", label: "Care instructions", dataType: "text" },
  { key: "country_of_origin", label: "Country of origin", dataType: "text", structuredDataProperty: "countryOfOrigin" },
  { key: "box_contents", label: "What's in the box", dataType: "text", cardinality: "multiple", searchable: true, aliases: ["Box contents", "In the box"] },
];

/** `products.details` keys and the system definition each one is. */
export const LEGACY_DETAIL_DEFINITIONS: Record<string, string> = {
  manufacturer: "manufacturer",
  modelName: "model_name",
  releaseDate: "release_date",
  unitCount: "unit_count",
  unitType: "unit_type",
  material: "material",
  color: "color",
  size: "size",
  dimensions: "dimensions",
  itemWeight: "item_weight",
  packageDimensions: "package_dimensions",
  packageWeight: "package_weight",
  compatibility: "compatibility_notes",
  specialFeatures: "special_features",
  intendedUse: "intended_use",
  careInstructions: "care_instructions",
};

/** `products.details` keys that are identifiers rather than attributes. */
export const LEGACY_DETAIL_IDENTIFIERS: Record<string, "mpn" | "model_number"> = {
  manufacturerPartNumber: "mpn",
  modelNumber: "model_number",
};

export const LEGACY_SOURCE_KEY = "legacy:products";

export type OptionRecord = {
  id: string;
  key: string;
  label: string;
  status: PkbReviewStatus;
  aliases: string[];
};

export type DefinitionRecord = {
  id: string;
  key: string;
  label: string;
  dataType: AttributeDataType;
  cardinality: "single" | "multiple";
  unitDimension: string | null;
  displayUnit: string | null;
  status: PkbReviewStatus;
  isSystem: boolean;
  searchable: boolean;
  filterable: boolean;
  seoRelevant: boolean;
  structuredDataProperty: string | null;
  aliases: string[];
  options: OptionRecord[];
};

/**
 * Makes sure the system definitions, their aliases and the legacy source row
 * exist. Idempotent and cheap when they do; safe under concurrency.
 */
export async function ensureSystemVocabulary(executor: Executor): Promise<{ legacySourceId: string }> {
  await ensureDefaultPolicies(executor);
  const [existing, [legacy]] = await Promise.all([
    executor
      .select({ key: pkbAttributeDefinitions.key })
      .from(pkbAttributeDefinitions)
      .where(eq(pkbAttributeDefinitions.isSystem, true)),
    executor.select({ id: pkbSources.id }).from(pkbSources).where(eq(pkbSources.sourceKey, LEGACY_SOURCE_KEY)),
  ]);

  const have = new Set(existing.map((row: { key: string }) => row.key));
  const missing = SYSTEM_DEFINITIONS.filter((definition) => !have.has(definition.key));

  if (missing.length > 0) {
    const now = new Date();
    await executor
      .insert(pkbAttributeDefinitions)
      .values(
        missing.map((definition) => ({
          key: definition.key,
          label: definition.label,
          dataType: definition.dataType,
          cardinality: definition.cardinality ?? "single",
          unitDimension: definition.unitDimension ?? null,
          displayUnit: definition.displayUnit ?? null,
          searchable: definition.searchable ?? false,
          filterable: definition.filterable ?? false,
          seoRelevant: definition.seoRelevant ?? false,
          structuredDataProperty: definition.structuredDataProperty ?? null,
          isSystem: true,
          status: "approved" as const,
          origin: "MANIFEST_CREATED" as const,
          decidedAt: now,
        })),
      )
      .onConflictDoNothing();

    const rows: { id: string; key: string }[] = await executor
      .select({ id: pkbAttributeDefinitions.id, key: pkbAttributeDefinitions.key })
      .from(pkbAttributeDefinitions)
      .where(inArray(pkbAttributeDefinitions.key, missing.map((definition) => definition.key)));
    const idByKey = new Map(rows.map((row) => [row.key, row.id]));
    const aliasRows = missing.flatMap((definition) =>
      (definition.aliases ?? []).map((alias) => ({
        targetKind: "definition" as const,
        definitionId: idByKey.get(definition.key)!,
        alias,
        aliasNormalized: labelKey(alias),
        aliasKind: "spelling_variant" as const,
        status: "approved" as const,
        origin: "MANIFEST_CREATED" as const,
        decidedAt: now,
      })),
    );
    if (aliasRows.length > 0) await executor.insert(pkbAliases).values(aliasRows).onConflictDoNothing();
  }

  if (legacy) return { legacySourceId: legacy.id };

  await executor
    .insert(pkbSources)
    .values({
      sourceKey: LEGACY_SOURCE_KEY,
      sourceType: "legacy_import",
      acquisitionMethod: "legacy_import",
      origin: "UNKNOWN_LEGACY",
      usageRights: "unknown",
      title: "Listing data entered before the knowledge base existed",
    })
    .onConflictDoNothing();
  const [created] = await executor
    .select({ id: pkbSources.id })
    .from(pkbSources)
    .where(eq(pkbSources.sourceKey, LEGACY_SOURCE_KEY));
  return { legacySourceId: created.id };
}

type DefinitionRow = typeof pkbAttributeDefinitions.$inferSelect;

function toRecord(row: DefinitionRow, options: OptionRecord[], aliases: string[]): DefinitionRecord {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    dataType: row.dataType as AttributeDataType,
    cardinality: row.cardinality,
    unitDimension: row.unitDimension,
    displayUnit: row.displayUnit,
    status: row.status,
    isSystem: row.isSystem,
    searchable: row.searchable,
    filterable: row.filterable,
    seoRelevant: row.seoRelevant,
    structuredDataProperty: row.structuredDataProperty,
    aliases,
    options,
  };
}

/** Definitions with their options and approved aliases. All when `ids` is omitted. */
export async function loadDefinitions(executor: Executor, ids?: string[]): Promise<DefinitionRecord[]> {
  if (ids && ids.length === 0) return [];
  const rows: DefinitionRow[] = await executor
    .select()
    .from(pkbAttributeDefinitions)
    .where(ids ? inArray(pkbAttributeDefinitions.id, ids) : sql`true`);
  if (rows.length === 0) return [];
  const definitionIds = rows.map((row) => row.id);

  /*
   * Every listing save loads this, so it is worth being plain about the shape
   * (risk R-2). Two things used to make it the most expensive part of a save on
   * a large catalogue. The options and aliases were fetched with an IN list of
   * every definition id — 471 uuids in the statement text when the caller
   * wanted them all, which is the whole table asked for the long way round.
   * And the rows were then joined in JavaScript with a nested `filter` per
   * definition and per option, which is O(definitions × options). Both are now
   * one pass: the query says "all of them" when that is what was asked for, and
   * the grouping is done with maps. Same rows, same order, no cache.
   */
  const wantsAll = ids === undefined;

  const [options, aliases]: [
    (typeof pkbAttributeOptions.$inferSelect)[],
    { definitionId: string | null; optionId: string | null; alias: string; targetKind: string }[],
  ] = await Promise.all([
    executor
      .select()
      .from(pkbAttributeOptions)
      .where(wantsAll ? sql`true` : inArray(pkbAttributeOptions.definitionId, definitionIds))
      .orderBy(pkbAttributeOptions.sortOrder, pkbAttributeOptions.label),
    executor
      .select({
        definitionId: pkbAliases.definitionId,
        optionId: pkbAliases.optionId,
        alias: pkbAliases.alias,
        targetKind: pkbAliases.targetKind,
      })
      .from(pkbAliases)
      .where(
        and(
          wantsAll ? sql`${pkbAliases.definitionId} is not null` : inArray(pkbAliases.definitionId, definitionIds),
          eq(pkbAliases.status, "approved"),
          ne(pkbAliases.targetKind, "brand"),
        ),
      ),
  ]);

  const optionsByDefinition = new Map<string, (typeof pkbAttributeOptions.$inferSelect)[]>();
  for (const option of options) {
    const list = optionsByDefinition.get(option.definitionId);
    if (list) list.push(option);
    else optionsByDefinition.set(option.definitionId, [option]);
  }

  const aliasesByOption = new Map<string, string[]>();
  const aliasesByDefinition = new Map<string, string[]>();
  for (const alias of aliases) {
    if (alias.targetKind === "option" && alias.optionId) {
      const list = aliasesByOption.get(alias.optionId);
      if (list) list.push(alias.alias);
      else aliasesByOption.set(alias.optionId, [alias.alias]);
    } else if (alias.targetKind === "definition" && alias.definitionId) {
      const list = aliasesByDefinition.get(alias.definitionId);
      if (list) list.push(alias.alias);
      else aliasesByDefinition.set(alias.definitionId, [alias.alias]);
    }
  }

  return rows.map((row) =>
    toRecord(
      row,
      (optionsByDefinition.get(row.id) ?? []).map((option) => ({
        id: option.id,
        key: option.key,
        label: option.label,
        status: option.status,
        aliases: aliasesByOption.get(option.id) ?? [],
      })),
      aliasesByDefinition.get(row.id) ?? [],
    ),
  );
}

/**
 * Finds the one reusable definition a label names — by label, key or approved
 * alias. Suggested and retired definitions are not reusable, so they never
 * match. Two definitions answering to the same label is `ambiguous`, not a
 * coin toss.
 */
export function matchDefinitionByLabel(
  definitions: DefinitionRecord[],
  label: string,
): { kind: "match"; definition: DefinitionRecord } | { kind: "none" } | { kind: "ambiguous" } {
  const key = labelKey(label);
  if (!key) return { kind: "none" };
  const matches = definitions.filter(
    (definition) =>
      definition.status === "approved" &&
      (labelKey(definition.label) === key ||
        labelKey(definition.key.replace(/_/g, " ")) === key ||
        definition.aliases.some((alias) => labelKey(alias) === key)),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "match", definition: matches[0] };
}

/** The first free definition key starting from `base`. */
export async function freeDefinitionKey(executor: Executor, base: string): Promise<string> {
  const rows: { key: string }[] = await executor
    .select({ key: pkbAttributeDefinitions.key })
    .from(pkbAttributeDefinitions)
    .where(sql`${pkbAttributeDefinitions.key} = ${base} or ${pkbAttributeDefinitions.key} like ${`${base}\\_%`}`);
  const taken = new Set(rows.map((row) => row.key));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base.slice(0, 58)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
