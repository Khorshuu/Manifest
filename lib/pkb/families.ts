import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  categoryAttributes,
  pkbAttributeDefinitions,
  pkbAttributeOptions,
  pkbClaims,
  pkbFacts,
  pkbFamilies,
  pkbFamilyAttributes,
  pkbFamilyVersions,
  pkbLegacyAttributeMap,
  pkbProducts,
  type PkbRequirement,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { lockFamilyMirror, PkbError, queryRows, type Attribution, type Executor } from "./common";
import { keyFromLabel, labelKey, type AttributeDataType } from "./normalize";
import { findUnit } from "./units";
import { freeDefinitionKey, loadDefinitions, type DefinitionRecord } from "./vocabulary";

/**
 * Product Families: versioned, data-driven schemas (D-064).
 *
 * Two ways a family comes to exist. Staff suggest one for a product that fits
 * no approved family, and someone with `knowledge.manage` approves it. Or it
 * mirrors a category that defines specifications (A-3): while the category
 * specification editor is still the screen staff use, this module keeps those
 * families' schemas in step with it, one version per change.
 */

// ------------------------------------------------------------------ helpers

function actorOf(attribution: Attribution): string | null {
  return attribution.kind === "legacy" ? null : attribution.actorId;
}

function optionKey(label: string, index: number): string {
  const base = labelKey(label).replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 60);
  return /^[a-z0-9]/.test(base) ? base : `option_${index + 1}`;
}

async function freeFamilyKey(executor: Executor, base: string): Promise<string> {
  const rows: { key: string }[] = await executor
    .select({ key: pkbFamilies.key })
    .from(pkbFamilies)
    .where(sql`${pkbFamilies.key} = ${base} or ${pkbFamilies.key} like ${`${base}\\_%`}`);
  const taken = new Set(rows.map((row) => row.key));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base.slice(0, 58)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

type LegacyShape = {
  dataType: AttributeDataType;
  cardinality: "single" | "multiple";
  unitDimension: string | null;
  displayUnit: string | null;
};

/** What a category specification is, in knowledge-base terms. */
export function legacyAttributeShape(attribute: { dataType: string; unit: string | null }): LegacyShape {
  switch (attribute.dataType) {
    case "number":
      return { dataType: "number", cardinality: "single", unitDimension: null, displayUnit: attribute.unit };
    case "measurement": {
      const unit = attribute.unit ? findUnit(attribute.unit) : undefined;
      return unit
        ? { dataType: "quantity", cardinality: "single", unitDimension: unit.dimension, displayUnit: unit.code }
        : { dataType: "number", cardinality: "single", unitDimension: null, displayUnit: attribute.unit };
    }
    case "boolean":
      return { dataType: "boolean", cardinality: "single", unitDimension: null, displayUnit: null };
    case "select":
      return { dataType: "enum", cardinality: "single", unitDimension: null, displayUnit: null };
    case "multiselect":
      return { dataType: "enum", cardinality: "multiple", unitDimension: null, displayUnit: null };
    case "date":
      return { dataType: "date", cardinality: "single", unitDimension: null, displayUnit: null };
    case "url":
      return { dataType: "url", cardinality: "single", unitDimension: null, displayUnit: null };
    default:
      return { dataType: "text", cardinality: "single", unitDimension: null, displayUnit: attribute.unit };
  }
}

async function ensureOptions(
  executor: Executor,
  definitionId: string,
  labels: string[],
  origin: "MANIFEST_CREATED",
): Promise<void> {
  const existing: (typeof pkbAttributeOptions.$inferSelect)[] = await executor
    .select()
    .from(pkbAttributeOptions)
    .where(eq(pkbAttributeOptions.definitionId, definitionId));
  const byLabel = new Map(existing.map((option) => [labelKey(option.label), option]));
  const takenKeys = new Set(existing.map((option) => option.key));
  const wanted = new Set<string>();

  for (const [index, label] of labels.entries()) {
    const found = byLabel.get(labelKey(label));
    wanted.add(labelKey(label));
    if (found) {
      if (found.status !== "approved" || found.sortOrder !== index || found.label !== label) {
        await executor
          .update(pkbAttributeOptions)
          .set({ status: "approved", sortOrder: index, label })
          .where(eq(pkbAttributeOptions.id, found.id));
      }
      continue;
    }
    let key = optionKey(label, index);
    for (let suffix = 2; takenKeys.has(key); suffix++) key = `${optionKey(label, index).slice(0, 58)}_${suffix}`;
    takenKeys.add(key);
    await executor.insert(pkbAttributeOptions).values({ definitionId, key, label, sortOrder: index, status: "approved", origin });
  }

  // An option taken off the list can no longer be chosen; values already
  // stored against it stay, so it is retired rather than deleted.
  const retire = existing.filter((option) => !wanted.has(labelKey(option.label)) && option.status !== "retired");
  if (retire.length > 0) {
    await executor
      .update(pkbAttributeOptions)
      .set({ status: "retired" })
      .where(inArray(pkbAttributeOptions.id, retire.map((option) => option.id)));
  }
}

async function definitionInUse(executor: Executor, definitionId: string): Promise<boolean> {
  const [row] = await queryRows<{ used: boolean }>(
    executor,
    sql`select exists (select 1 from ${pkbFacts} where ${pkbFacts.definitionId} = ${definitionId})
        or exists (select 1 from ${pkbClaims} where ${pkbClaims.definitionId} = ${definitionId}) as used`,
  );
  return Boolean(row?.used);
}

type MirrorReport = {
  definitionsCreated: number;
  definitionsChanged: number;
  familiesCreated: number;
  versionsCreated: number;
  listingsQueued: number;
};

/**
 * Keeps the families mirrored from categories equal to the categories'
 * specification definitions. Idempotent: with nothing changed it reads and
 * writes nothing else. Must run inside a transaction.
 */
export async function syncLegacyFamilies(executor: Executor, attribution: Attribution): Promise<MirrorReport> {
  await lockFamilyMirror(executor);
  const actor = actorOf(attribution);
  const report: MirrorReport = {
    definitionsCreated: 0,
    definitionsChanged: 0,
    familiesCreated: 0,
    versionsCreated: 0,
    listingsQueued: 0,
  };
  const now = new Date();

  const [allCategories, attributes, mapRows] = await Promise.all([
    executor
      .select({
        id: categories.id,
        parentId: categories.parentId,
        name: categories.name,
        slug: categories.slug,
        defaultFamilyId: categories.defaultFamilyId,
      })
      .from(categories),
    executor
      .select()
      .from(categoryAttributes)
      .orderBy(asc(categoryAttributes.categoryId), asc(categoryAttributes.sortOrder), asc(categoryAttributes.name)),
    executor.select().from(pkbLegacyAttributeMap),
  ]) as [
    { id: string; parentId: string | null; name: string; slug: string; defaultFamilyId: string | null }[],
    (typeof categoryAttributes.$inferSelect)[],
    (typeof pkbLegacyAttributeMap.$inferSelect)[],
  ];

  // 1. Definitions — one per category specification, never merged by guess.
  const mapped = new Map(mapRows.map((row) => [row.categoryAttributeId, row.definitionId]));
  const definitions = new Map(
    (await loadDefinitions(executor, [...new Set(mapRows.map((row) => row.definitionId))])).map((row) => [row.id, row]),
  );
  const remapped: string[] = [];

  for (const attribute of attributes) {
    const shape = legacyAttributeShape(attribute);
    const flags = { searchable: attribute.isSearchable, filterable: attribute.isFilterable };
    const current = mapped.get(attribute.id) ? definitions.get(mapped.get(attribute.id)!) : undefined;
    let definitionId = current?.id;

    const sameShape = (definition: DefinitionRecord) =>
      definition.dataType === shape.dataType &&
      definition.cardinality === shape.cardinality &&
      (definition.unitDimension ?? null) === shape.unitDimension;

    if (current && sameShape(current)) {
      if (
        current.label !== attribute.name ||
        (current.displayUnit ?? null) !== shape.displayUnit ||
        current.searchable !== flags.searchable ||
        current.filterable !== flags.filterable
      ) {
        await executor
          .update(pkbAttributeDefinitions)
          .set({ label: attribute.name, displayUnit: shape.displayUnit, ...flags, updatedAt: now })
          .where(eq(pkbAttributeDefinitions.id, current.id));
        report.definitionsChanged += 1;
      }
    } else if (current && !(await definitionInUse(executor, current.id))) {
      await executor
        .update(pkbAttributeDefinitions)
        .set({ label: attribute.name, ...shape, ...flags, updatedAt: now })
        .where(eq(pkbAttributeDefinitions.id, current.id));
      report.definitionsChanged += 1;
    } else {
      // New, or its type changed under stored values: a new definition, and
      // the values move to it on the listings' next sync (with provenance).
      const key = await freeDefinitionKey(executor, keyFromLabel(attribute.name));
      const [created] = await executor
        .insert(pkbAttributeDefinitions)
        .values({
          key,
          label: attribute.name,
          ...shape,
          ...flags,
          status: "approved",
          origin: "MANIFEST_CREATED",
          createdBy: actor,
          decidedBy: actor,
          decidedAt: now,
        })
        .returning({ id: pkbAttributeDefinitions.id });
      definitionId = created.id;
      report.definitionsCreated += 1;
      if (current) {
        await executor
          .update(pkbLegacyAttributeMap)
          .set({ definitionId })
          .where(eq(pkbLegacyAttributeMap.categoryAttributeId, attribute.id));
        remapped.push(attribute.id);
      } else {
        await executor.insert(pkbLegacyAttributeMap).values({ categoryAttributeId: attribute.id, definitionId });
      }
      mapped.set(attribute.id, definitionId!);
    }

    if (shape.dataType === "enum") {
      const labels = Array.isArray(attribute.options) ? (attribute.options as string[]) : [];
      await ensureOptions(executor, definitionId!, labels, "MANIFEST_CREATED");
    }
  }

  // 2. Families — top-down, so a parent exists before its children point at it.
  const byId = new Map(allCategories.map((row) => [row.id, row]));
  const depth = (id: string) => {
    let level = 0;
    for (let cursor = byId.get(id); cursor?.parentId && level < 32; cursor = byId.get(cursor.parentId)) level++;
    return level;
  };
  const ownAttributes = new Map<string, typeof attributes>();
  for (const attribute of attributes) {
    ownAttributes.set(attribute.categoryId, [...(ownAttributes.get(attribute.categoryId) ?? []), attribute]);
  }

  const mirrored: (typeof pkbFamilies.$inferSelect)[] = await executor
    .select()
    .from(pkbFamilies)
    .where(isNotNull(pkbFamilies.legacyCategoryId));
  const familyByCategory = new Map(mirrored.map((family) => [family.legacyCategoryId!, family]));

  const nearestFamily = (categoryId: string | null, includeSelf: boolean): string | null => {
    let cursor = categoryId ? byId.get(categoryId) : undefined;
    if (cursor && !includeSelf) cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    for (let guard = 0; cursor && guard < 32; guard++) {
      const family = familyByCategory.get(cursor.id);
      if (family) return family.id;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return null;
  };

  const ordered = [...allCategories].sort((a, b) => depth(a.id) - depth(b.id));
  for (const category of ordered) {
    const own = ownAttributes.get(category.id) ?? [];
    let family = familyByCategory.get(category.id);
    if (!family && own.length === 0) continue;

    const parentId = nearestFamily(category.id, false);
    if (!family) {
      const key = await freeFamilyKey(executor, keyFromLabel(category.slug.replace(/-/g, " ")));
      [family] = await executor
        .insert(pkbFamilies)
        .values({
          key,
          name: category.name,
          parentId,
          status: "approved",
          origin: "MANIFEST_CREATED",
          legacyCategoryId: category.id,
          suggestedBy: actor,
          decidedBy: actor,
          decidedAt: now,
        })
        .returning();
      familyByCategory.set(category.id, family!);
      report.familiesCreated += 1;
    } else if (family.name !== category.name || family.parentId !== parentId) {
      await executor
        .update(pkbFamilies)
        .set({ name: category.name, parentId, updatedAt: now })
        .where(eq(pkbFamilies.id, family.id));
    }

    const desired = own.map((attribute, index) => ({
      definitionId: mapped.get(attribute.id)!,
      requirement: (attribute.isRequired ? "required" : "optional") as PkbRequirement,
      searchable: attribute.isSearchable,
      filterable: attribute.isFilterable,
      sortOrder: index,
    }));
    const changed = await replaceActiveSchemaIfDifferent(executor, family!.id, desired, actor, "Mirrored from the category's specifications.");
    if (changed) report.versionsCreated += 1;
  }

  // 3. Each category's default family — its own or its nearest ancestor's.
  const movedCategories: string[] = [];
  for (const category of allCategories) {
    const next = nearestFamily(category.id, true);
    if ((category.defaultFamilyId ?? null) !== next) {
      await executor.update(categories).set({ defaultFamilyId: next }).where(eq(categories.id, category.id));
      movedCategories.push(category.id);
    }
  }

  // 4. Listings whose assignment or values need re-reading.
  if (movedCategories.length > 0 || remapped.length > 0) {
    const rows = await queryRows<{ n: number }>(
      executor,
      sql`with ids as (
            select p.id from products p
            where p.category_id = any(${`{${movedCategories.join(",")}}`}::uuid[])
               or exists (
                 select 1 from unnest(${`{${remapped.join(",")}}`}::uuid[]) as r(id)
                 where p.attribute_values ? r.id::text
               )
          )
          select count(*)::int as n from ids, lateral (select pkb_queue_listings(array[ids.id])) q`,
    );
    report.listingsQueued = Number(rows[0]?.n ?? 0);
  }

  return report;
}

type DesiredAttribute = {
  definitionId: string;
  requirement: PkbRequirement;
  variantDefining?: boolean;
  searchable?: boolean | null;
  filterable?: boolean | null;
  seoRelevant?: boolean | null;
  groupLabel?: string | null;
  sortOrder: number;
};

function attributeSignature(rows: DesiredAttribute[]): string {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId))
      .map((row) => [
        row.definitionId,
        row.requirement,
        row.variantDefining ?? false,
        row.searchable ?? null,
        row.filterable ?? null,
        row.seoRelevant ?? null,
        row.groupLabel ?? null,
        row.sortOrder,
      ]),
  );
}

/** Creates and activates a new version when the desired schema differs from the active one. */
async function replaceActiveSchemaIfDifferent(
  executor: Executor,
  familyId: string,
  desired: DesiredAttribute[],
  actor: string | null,
  note: string,
): Promise<boolean> {
  const [active] = await executor
    .select()
    .from(pkbFamilyVersions)
    .where(and(eq(pkbFamilyVersions.familyId, familyId), eq(pkbFamilyVersions.status, "active")));
  if (active) {
    const current: DesiredAttribute[] = await executor
      .select()
      .from(pkbFamilyAttributes)
      .where(eq(pkbFamilyAttributes.familyVersionId, active.id));
    if (attributeSignature(current) === attributeSignature(desired)) return false;
  }
  const versionId = await createDraftVersion(executor, familyId, desired, actor, note);
  await activateVersion(executor, versionId, actor);
  return true;
}

async function createDraftVersion(
  executor: Executor,
  familyId: string,
  attributes: DesiredAttribute[],
  actor: string | null,
  note: string | null,
): Promise<string> {
  const [{ next }] = await queryRows<{ next: number }>(
    executor,
    sql`select coalesce(max(version), 0)::int + 1 as next from pkb_family_versions where family_id = ${familyId}`,
  );
  const [version] = await executor
    .insert(pkbFamilyVersions)
    .values({ familyId, version: Number(next), status: "draft", changeNote: note, createdBy: actor })
    .returning({ id: pkbFamilyVersions.id });
  if (attributes.length > 0) {
    await executor.insert(pkbFamilyAttributes).values(
      attributes.map((attribute) => ({
        familyVersionId: version.id,
        definitionId: attribute.definitionId,
        requirement: attribute.requirement,
        variantDefining: attribute.variantDefining ?? false,
        searchable: attribute.searchable ?? null,
        filterable: attribute.filterable ?? null,
        seoRelevant: attribute.seoRelevant ?? null,
        groupLabel: attribute.groupLabel ?? null,
        sortOrder: attribute.sortOrder,
      })),
    );
  }
  return version.id;
}

async function activateVersion(executor: Executor, versionId: string, actor: string | null): Promise<void> {
  const [version] = await executor.select().from(pkbFamilyVersions).where(eq(pkbFamilyVersions.id, versionId));
  if (!version) throw new PkbError("That family version does not exist.", 404);
  if (version.status !== "draft") throw new PkbError("Only a draft version can be activated.", 409);
  const now = new Date();
  // The one-active index means the old version retires first.
  await executor
    .update(pkbFamilyVersions)
    .set({ status: "retired" })
    .where(and(eq(pkbFamilyVersions.familyId, version.familyId), eq(pkbFamilyVersions.status, "active")));
  await executor
    .update(pkbFamilyVersions)
    .set({ status: "active", activatedAt: now, activatedBy: actor })
    .where(eq(pkbFamilyVersions.id, versionId));
}

// ------------------------------------------------------------------ schema

export type FamilySchemaAttribute = {
  definition: DefinitionRecord;
  requirement: PkbRequirement;
  variantDefining: boolean;
  searchable: boolean;
  filterable: boolean;
  seoRelevant: boolean;
  groupLabel: string | null;
  /** The family the attribute is declared on (a parent, when inherited). */
  familyId: string;
  sortOrder: number;
};

/**
 * A family's effective schema: its active version plus every ancestor's,
 * outermost first. A family may tighten an inherited attribute (optional →
 * required) by listing it again.
 */
export async function resolveFamilySchema(executor: Executor, familyId: string): Promise<FamilySchemaAttribute[]> {
  const lineage = await queryRows<{ id: string; depth: number }>(
    executor,
    sql`with recursive up as (
          select id, parent_id, 0 as depth from pkb_families where id = ${familyId}
          union all
          select f.id, f.parent_id, up.depth + 1 from pkb_families f join up on f.id = up.parent_id where up.depth < 16
        )
        select id, depth from up order by depth desc`,
  );
  if (lineage.length === 0) return [];

  const rows = await queryRows<{
    family_id: string;
    definition_id: string;
    requirement: PkbRequirement;
    variant_defining: boolean;
    searchable: boolean | null;
    filterable: boolean | null;
    seo_relevant: boolean | null;
    group_label: string | null;
    sort_order: number;
  }>(
    executor,
    sql`select v.family_id, a.definition_id, a.requirement, a.variant_defining, a.searchable, a.filterable,
               a.seo_relevant, a.group_label, a.sort_order
        from pkb_family_versions v
        join pkb_family_attributes a on a.family_version_id = v.id
        where v.status = 'active' and v.family_id = any(${`{${lineage.map((row) => row.id).join(",")}}`}::uuid[])`,
  );
  const definitions = new Map(
    (await loadDefinitions(executor, [...new Set(rows.map((row) => row.definition_id))])).map((row) => [row.id, row]),
  );
  const order = new Map(lineage.map((row, index) => [row.id, index]));
  rows.sort((a, b) => order.get(a.family_id)! - order.get(b.family_id)! || a.sort_order - b.sort_order);

  const byDefinition = new Map<string, FamilySchemaAttribute>();
  for (const row of rows) {
    const definition = definitions.get(row.definition_id)!;
    byDefinition.set(row.definition_id, {
      definition,
      requirement: row.requirement,
      variantDefining: row.variant_defining,
      searchable: row.searchable ?? definition.searchable,
      filterable: row.filterable ?? definition.filterable,
      seoRelevant: row.seo_relevant ?? definition.seoRelevant,
      groupLabel: row.group_label,
      familyId: row.family_id,
      sortOrder: row.sort_order,
    });
  }
  return [...byDefinition.values()];
}

// ------------------------------------------------------------------ services

export type SuggestFamilyInput = {
  name: string;
  key?: string;
  description?: string | null;
  parentId?: string | null;
  attributes: DesiredAttribute[];
  /** The product that prompted it; it is marked as waiting for this family. */
  forPkbProductId?: string;
};

async function assertDefinitionsUsable(executor: Executor, attributes: DesiredAttribute[]) {
  const ids = [...new Set(attributes.map((attribute) => attribute.definitionId))];
  if (ids.length !== attributes.length) throw new PkbError("An attribute is listed twice.");
  const definitions = await loadDefinitions(executor, ids);
  if (definitions.length !== ids.length) throw new PkbError("One of those attributes does not exist.", 404);
  const retired = definitions.find((definition) => definition.status === "retired");
  if (retired) throw new PkbError(`${retired.label} is retired and cannot be added to a family.`);
}

/**
 * Proposes a family for a kind of product no approved family fits. Anyone who
 * manages the catalogue may suggest; it is not reusable until approved.
 */
export async function suggestFamily(actor: SessionUser | null, input: SuggestFamilyInput) {
  const staff = requirePermission(actor, "catalog.manage");
  const name = input.name.trim();
  if (!name) throw new PkbError("Name the family.");

  return db.transaction(async (tx) => {
    await assertDefinitionsUsable(tx, input.attributes);
    if (input.parentId) {
      const [parent] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, input.parentId));
      if (!parent || parent.status !== "approved") throw new PkbError("A family can only extend an approved family.");
    }
    const key = await freeFamilyKey(tx, input.key ? keyFromLabel(input.key) : keyFromLabel(name));
    const [family] = await tx
      .insert(pkbFamilies)
      .values({
        key,
        name,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        status: "suggested",
        origin: "MANUAL_ADMIN",
        suggestedBy: staff.id,
      })
      .returning();
    await createDraftVersion(tx, family.id, input.attributes, staff.id, "Suggested.");

    if (input.forPkbProductId) {
      const [product] = await tx.select().from(pkbProducts).where(eq(pkbProducts.id, input.forPkbProductId));
      if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
      if (product.familyAssignment === "assigned") {
        throw new PkbError("That product already has an approved family. Reassign it instead of suggesting a new one.", 409);
      }
      await tx
        .update(pkbProducts)
        .set({ familyId: family.id, familyAssignment: "suggested", familyAssignmentSource: "manual", updatedAt: new Date() })
        .where(eq(pkbProducts.id, product.id));
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.family_suggested",
        entityType: "pkb_family",
        entityId: family.id,
        after: { key, name, attributes: input.attributes.length, forProduct: input.forPkbProductId ?? null },
      },
      tx,
    );
    return family;
  });
}

/** Approves a suggested family: its draft schema becomes version 1, and waiting products are assigned. */
export async function approveFamily(actor: SessionUser | null, familyId: string) {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [family] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, familyId)).for("update");
    if (!family) throw new PkbError("That family does not exist.", 404);
    if (family.status !== "suggested") throw new PkbError(`That family is already ${family.status}.`, 409);

    const now = new Date();
    await tx
      .update(pkbFamilies)
      .set({ status: "approved", decidedBy: staff.id, decidedAt: now, updatedAt: now })
      .where(eq(pkbFamilies.id, familyId));
    const [draft] = await tx
      .select()
      .from(pkbFamilyVersions)
      .where(and(eq(pkbFamilyVersions.familyId, familyId), eq(pkbFamilyVersions.status, "draft")))
      .orderBy(desc(pkbFamilyVersions.version))
      .limit(1);
    if (draft) await activateVersion(tx, draft.id, staff.id);
    const assigned = await tx
      .update(pkbProducts)
      .set({ familyAssignment: "assigned", updatedAt: now })
      .where(and(eq(pkbProducts.familyId, familyId), eq(pkbProducts.familyAssignment, "suggested")))
      .returning({ id: pkbProducts.id });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.family_approved",
        entityType: "pkb_family",
        entityId: familyId,
        after: { productsAssigned: assigned.length },
      },
      tx,
    );
    return { assigned: assigned.length };
  });
}

/** Rejects a suggested family; products waiting for it go back to unassigned. */
export async function rejectFamily(actor: SessionUser | null, familyId: string, note?: string) {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [family] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, familyId)).for("update");
    if (!family) throw new PkbError("That family does not exist.", 404);
    if (family.status !== "suggested") throw new PkbError("Only a suggested family can be rejected.", 409);
    const now = new Date();
    await tx
      .update(pkbProducts)
      .set({ familyId: null, familyAssignment: "unassigned", familyAssignmentSource: null, updatedAt: now })
      .where(eq(pkbProducts.familyId, familyId));
    await tx
      .update(pkbFamilies)
      .set({ status: "retired", decidedBy: staff.id, decidedAt: now, updatedAt: now })
      .where(eq(pkbFamilies.id, familyId));
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.family_rejected", entityType: "pkb_family", entityId: familyId, after: { note: note ?? null } },
      tx,
    );
  });
}

/**
 * Schema evolution: a new draft version holding the given attributes. Stored
 * values are never touched — an attribute dropped from the family stays on
 * the products that carry it, as a product-only attribute.
 */
export async function draftFamilyVersion(
  actor: SessionUser | null,
  familyId: string,
  attributes: DesiredAttribute[],
  note: string,
) {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [family] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, familyId));
    if (!family) throw new PkbError("That family does not exist.", 404);
    if (family.legacyCategoryId) {
      throw new PkbError(
        "This family mirrors a category's specifications. Change them on the category until the family editor replaces it.",
        409,
      );
    }
    await assertDefinitionsUsable(tx, attributes);
    const versionId = await createDraftVersion(tx, familyId, attributes, staff.id, note);
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.family_version_drafted", entityType: "pkb_family", entityId: familyId, after: { versionId, note } },
      tx,
    );
    return versionId;
  });
}

export async function activateFamilyVersion(actor: SessionUser | null, versionId: string) {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [version] = await tx.select().from(pkbFamilyVersions).where(eq(pkbFamilyVersions.id, versionId));
    if (!version) throw new PkbError("That family version does not exist.", 404);
    const [family] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, version.familyId));
    if (family.status !== "approved") throw new PkbError("Approve the family before activating a version.", 409);
    await activateVersion(tx, versionId, staff.id);
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.family_version_activated", entityType: "pkb_family", entityId: version.familyId, after: { versionId, version: version.version } },
      tx,
    );
  });
}

/**
 * Assigns a product to an approved family, or unassigns it with null. A
 * manual assignment is kept: the category mirror no longer moves the product.
 */
export async function assignFamily(actor: SessionUser | null, pkbProductId: string, familyId: string | null) {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId)).for("update");
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    if (familyId) {
      const [family] = await tx.select().from(pkbFamilies).where(eq(pkbFamilies.id, familyId));
      if (!family || family.status !== "approved") throw new PkbError("Assign an approved family.", 409);
    }
    await tx
      .update(pkbProducts)
      .set(
        familyId
          ? { familyId, familyAssignment: "assigned", familyAssignmentSource: "manual", updatedAt: new Date() }
          : { familyId: null, familyAssignment: "unassigned", familyAssignmentSource: null, updatedAt: new Date() },
      )
      .where(eq(pkbProducts.id, pkbProductId));
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.family_assigned",
        entityType: "pkb_product",
        entityId: pkbProductId,
        before: { familyId: product.familyId, assignment: product.familyAssignment },
        after: { familyId },
      },
      tx,
    );
  });
}
