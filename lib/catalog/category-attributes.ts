import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  categoryAttributes,
  products,
  type CategoryAttributeType,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { staffChange, type Executor } from "@/lib/pkb/common";
import { syncLegacyFamilies } from "@/lib/pkb/families";
import { beginListingChange, syncListingKnowledge } from "@/lib/pkb/sync";
import type { CategoryAttributeInputPayload } from "@/lib/validation/catalog";

/**
 * Specifications, defined per category at runtime.
 *
 * A new kind of product needs new fields to describe itself — a monitor has a
 * refresh rate, a jacket has a fabric — and adding a column for each of them
 * would mean a migration every time the shop takes on a shelf. So the
 * definitions are rows, the values are a JSON object on the product keyed by
 * definition id, and the core product table never changes again for this.
 *
 * Definitions are inherited down the category tree: an attribute defined on
 * "Electronics" is asked of everything filed beneath it. That is what stops
 * "Brand" from being re-entered under all forty leaf categories.
 */

export class CategoryAttributeError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "CategoryAttributeError";
  }
}

export type CategoryAttributeDefinition = {
  id: string;
  categoryId: string;
  /** The category the definition is written on — "Electronics", when inherited. */
  categoryName: string;
  name: string;
  dataType: CategoryAttributeType;
  unit: string | null;
  options: string[];
  isRequired: boolean;
  /** Offered as a filter on listings whose results carry a value for it. */
  isFilterable: boolean;
  /** Its values are words the site's search matches. */
  isSearchable: boolean;
  sortOrder: number;
};

type CategoryAttributeRow = {
  id: string;
  categoryId: string;
  categoryName: string | null;
  name: string;
  dataType: string;
  unit: string | null;
  options: unknown;
  isRequired: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  sortOrder: number;
};

function toDefinition(row: {
  id: string;
  categoryId: string;
  categoryName: string | null;
  name: string;
  dataType: string;
  unit: string | null;
  options: unknown;
  isRequired: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  sortOrder: number;
}): CategoryAttributeDefinition {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.categoryName ?? "",
    name: row.name,
    dataType: row.dataType as CategoryAttributeType,
    unit: row.unit,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    isRequired: row.isRequired,
    isFilterable: row.isFilterable,
    isSearchable: row.isSearchable,
    sortOrder: row.sortOrder,
  };
}

const definitionColumns = {
  id: categoryAttributes.id,
  categoryId: categoryAttributes.categoryId,
  categoryName: categories.name,
  name: categoryAttributes.name,
  dataType: categoryAttributes.dataType,
  unit: categoryAttributes.unit,
  options: categoryAttributes.options,
  isRequired: categoryAttributes.isRequired,
  isFilterable: categoryAttributes.isFilterable,
  isSearchable: categoryAttributes.isSearchable,
  sortOrder: categoryAttributes.sortOrder,
};

/**
 * Whether a kind of value makes a useful filter by default. A list of choices,
 * a number or a yes/no groups products into a handful of values; free text,
 * a link or a date gives every product its own, which is a filter nobody can
 * use. Staff can switch either way per attribute.
 */
export function filterableByDefault(dataType: CategoryAttributeType): boolean {
  return !["text", "url", "date"].includes(dataType);
}

/** The attributes written directly on one category. */
export async function listCategoryAttributes(
  categoryId: string,
): Promise<CategoryAttributeDefinition[]> {
  const rows = await db
    .select(definitionColumns)
    .from(categoryAttributes)
    .innerJoin(categories, eq(categoryAttributes.categoryId, categories.id))
    .where(eq(categoryAttributes.categoryId, categoryId))
    .orderBy(asc(categoryAttributes.sortOrder), asc(categoryAttributes.name));

  return rows.map(toDefinition);
}

/**
 * The category's own attributes plus everything inherited from its ancestors,
 * outermost first — so a product form reads "Electronics, then Monitors".
 *
 * The ancestry is walked in TypeScript over the whole category table rather
 * than in a recursive CTE. The table is small enough that this is one query
 * either way, and it keeps the ordering rule — general questions before
 * specific ones — in one readable place.
 */
export async function resolveCategoryAttributes(
  categoryId: string,
  /**
   * Read through a caller's transaction where there is one. A product save
   * validates its specification values inside its own transaction, and a
   * function called from there must not reach for a second connection: on a
   * pool that can be exhausted, a transaction waiting on another connection is
   * a deadlock waiting for load.
   */
  executor: Executor = db,
): Promise<CategoryAttributeDefinition[]> {
  const allCategories: { id: string; parentId: string | null; name: string }[] = await executor
    .select({
      id: categories.id,
      parentId: categories.parentId,
      name: categories.name,
    })
    .from(categories);

  const byId = new Map(allCategories.map((row) => [row.id, row]));

  // Innermost first while walking up, then reversed: an attribute defined on
  // "Electronics" should be asked before one defined on "Monitors".
  const lineage: string[] = [];
  let cursor = byId.get(categoryId);
  while (cursor) {
    lineage.push(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    // A cycle would be a data fault, but it must not hang a page render.
    if (lineage.length > 32) break;
  }
  lineage.reverse();

  if (lineage.length === 0) return [];

  const rows: CategoryAttributeRow[] = await executor
    .select(definitionColumns)
    .from(categoryAttributes)
    .innerJoin(categories, eq(categoryAttributes.categoryId, categories.id))
    .where(inArray(categoryAttributes.categoryId, lineage))
    .orderBy(asc(categoryAttributes.sortOrder), asc(categoryAttributes.name));

  const depthOf = new Map(lineage.map((id, index) => [id, index]));

  return rows
    .map(toDefinition)
    .sort(
      (a, b) =>
        (depthOf.get(a.categoryId) ?? 0) - (depthOf.get(b.categoryId) ?? 0) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    );
}

/** The definitions behind a set of stored values, for rendering them. */
export async function getAttributeDefinitionsByIds(
  ids: string[],
): Promise<CategoryAttributeDefinition[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select(definitionColumns)
    .from(categoryAttributes)
    .innerJoin(categories, eq(categoryAttributes.categoryId, categories.id))
    .where(inArray(categoryAttributes.id, ids));

  return rows.map(toDefinition);
}

/**
 * Adds one specification to a category inside the caller's transaction.
 * Attribute discovery uses this so that accepting a proposal, extending the
 * category and writing the value are one decision (D-073); the permission
 * check belongs to the caller.
 */
export async function createCategoryAttributeIn(
  executor: Executor,
  actorId: string,
  categoryId: string,
  input: CategoryAttributeInputPayload,
) {
  if (
    (input.dataType === "select" || input.dataType === "multiselect") &&
    (input.options ?? []).length === 0
  ) {
    throw new CategoryAttributeError(
      "A choice attribute needs at least one option to choose from.",
    );
  }

  const [{ nextOrder }] = await executor
    .select({
      nextOrder: sql<number>`coalesce(max(${categoryAttributes.sortOrder}) + 1, 0)::int`,
    })
    .from(categoryAttributes)
    .where(eq(categoryAttributes.categoryId, categoryId));

  const [created] = await executor
    .insert(categoryAttributes)
    .values({
      categoryId,
      name: input.name,
      dataType: input.dataType,
      unit: input.unit ?? null,
      options: input.options ?? null,
      isRequired: input.isRequired ?? false,
      isFilterable:
        input.isFilterable ??
        filterableByDefault(input.dataType as CategoryAttributeType),
      isSearchable: input.isSearchable ?? true,
      sortOrder: nextOrder,
    })
    .returning();

  await recordAudit(
    {
      actorUserId: actorId,
      action: "category.updated",
      entityType: "category",
      entityId: categoryId,
      after: { attributeAdded: created.name, dataType: created.dataType },
    },
    executor,
  );

  // The category's family schema follows, as a new version (D-064).
  await syncLegacyFamilies(executor, staffChange(actorId));
  return created;
}

export async function createCategoryAttribute(
  actor: SessionUser | null,
  categoryId: string,
  input: CategoryAttributeInputPayload,
) {
  const staff = requirePermission(actor, "catalog.manage");

  if (
    (input.dataType === "select" || input.dataType === "multiselect") &&
    (input.options ?? []).length === 0
  ) {
    throw new CategoryAttributeError(
      "A choice attribute needs at least one option to choose from.",
    );
  }

  return db.transaction(async (tx) => createCategoryAttributeIn(tx, staff.id, categoryId, input));
}

export async function updateCategoryAttribute(
  actor: SessionUser | null,
  attributeId: string,
  input: CategoryAttributeInputPayload,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [before] = await db
    .select()
    .from(categoryAttributes)
    .where(eq(categoryAttributes.id, attributeId));

  if (!before) throw new CategoryAttributeError("That attribute no longer exists.");

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(categoryAttributes)
      .set({
        name: input.name,
        dataType: input.dataType,
        unit: input.unit ?? null,
        options: input.options ?? null,
        isRequired: input.isRequired ?? false,
        // Absent means unchanged: an older client that does not know about
        // these switches must not quietly turn them off.
        isFilterable: input.isFilterable ?? before.isFilterable,
        isSearchable: input.isSearchable ?? before.isSearchable,
      })
      .where(eq(categoryAttributes.id, attributeId))
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "category.updated",
        entityType: "category",
        entityId: before.categoryId,
        before: {
          name: before.name,
          dataType: before.dataType,
          isFilterable: before.isFilterable,
          isSearchable: before.isSearchable,
        },
        after: {
          name: updated.name,
          dataType: updated.dataType,
          isFilterable: updated.isFilterable,
          isSearchable: updated.isSearchable,
        },
      },
      tx,
    );

    // A type change moves stored values to a new definition; listings are
    // queued and keep each value's provenance when re-read (D-070).
    await syncLegacyFamilies(tx, staffChange(staff.id));
    return updated;
  });
}

/**
 * Removes a definition, and with it the values products stored against it.
 *
 * The values are a JSON object keyed by definition id, so leaving them behind
 * would be dead weight nothing could ever render again. This is specification
 * text, not order history — nothing a customer bought depends on it.
 */
export async function deleteCategoryAttribute(
  actor: SessionUser | null,
  attributeId: string,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [before] = await db
    .select()
    .from(categoryAttributes)
    .where(eq(categoryAttributes.id, attributeId));

  if (!before) throw new CategoryAttributeError("That attribute no longer exists.");

  await db.transaction(async (tx) => {
    const affected = (
      await tx
        .select({ id: products.id })
        .from(products)
        .where(sql`${products.attributeValues} ? ${attributeId}`)
        .orderBy(products.id)
    ).map((row) => row.id);
    for (const id of affected) await beginListingChange(tx, id);

    await tx
      .update(products)
      .set({
        attributeValues: sql`${products.attributeValues} - ${attributeId}`,
      })
      .where(sql`${products.attributeValues} ? ${attributeId}`);

    await tx
      .delete(categoryAttributes)
      .where(eq(categoryAttributes.id, attributeId));

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "category.updated",
        entityType: "category",
        entityId: before.categoryId,
        before: { name: before.name },
        after: { attributeRemoved: true },
      },
      tx,
    );

    // Removing the specification removed staff-typed values: cleared, with history.
    await syncLegacyFamilies(tx, staffChange(staff.id));
    for (const id of affected) await syncListingKnowledge(tx, id, staffChange(staff.id));
  });
}

export type AttributeValueMap = Record<string, string | string[]>;

/**
 * Checks submitted specification values against the definitions the product's
 * category actually asks for.
 *
 * Run on the server on every save, never only in the form: a value for an
 * attribute belonging to some other category, or a choice that is not one of
 * the offered options, is refused here rather than stored and rendered later.
 * Blank values are dropped rather than stored, which is what keeps empty rows
 * out of the specifications table on the product page.
 */
export function validateAttributeValues(
  definitions: CategoryAttributeDefinition[],
  submitted: Record<string, unknown>,
): AttributeValueMap {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const clean: AttributeValueMap = {};

  for (const [id, raw] of Object.entries(submitted)) {
    const definition = byId.get(id);
    if (!definition) {
      throw new CategoryAttributeError(
        "One of those specifications does not belong to this category.",
      );
    }

    if (definition.dataType === "multiselect") {
      const values = (Array.isArray(raw) ? raw : [raw])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);

      for (const value of values) {
        if (!definition.options.includes(value)) {
          throw new CategoryAttributeError(
            `"${value}" is not one of the choices for ${definition.name}.`,
          );
        }
      }

      if (values.length > 0) clean[id] = values;
      continue;
    }

    const value = String(raw ?? "").trim();
    if (value.length === 0) continue;
    if (value.length > 500) {
      throw new CategoryAttributeError(
        `${definition.name} is longer than 500 characters.`,
      );
    }

    switch (definition.dataType) {
      case "select":
        if (!definition.options.includes(value)) {
          throw new CategoryAttributeError(
            `"${value}" is not one of the choices for ${definition.name}.`,
          );
        }
        break;
      case "number":
      case "measurement":
        if (!Number.isFinite(Number(value))) {
          throw new CategoryAttributeError(`${definition.name} must be a number.`);
        }
        break;
      case "boolean":
        if (!["true", "false", "yes", "no"].includes(value.toLowerCase())) {
          throw new CategoryAttributeError(
            `${definition.name} must be yes or no.`,
          );
        }
        clean[id] = ["true", "yes"].includes(value.toLowerCase())
          ? "true"
          : "false";
        continue;
      case "date":
        if (Number.isNaN(Date.parse(value))) {
          throw new CategoryAttributeError(`${definition.name} must be a date.`);
        }
        break;
      case "url":
        if (!/^https?:\/\/\S+$/i.test(value)) {
          throw new CategoryAttributeError(
            `${definition.name} must be a link starting with http:// or https://.`,
          );
        }
        break;
      case "color":
      case "text":
        break;
    }

    clean[id] = value;
  }

  for (const definition of definitions) {
    if (definition.isRequired && clean[definition.id] === undefined) {
      throw new CategoryAttributeError(`${definition.name} is required.`);
    }
  }

  return clean;
}

/** How a stored value reads in the specifications table. */
export function formatAttributeValue(
  definition: CategoryAttributeDefinition,
  value: string | string[],
): string {
  if (Array.isArray(value)) return value.join(", ");
  if (definition.dataType === "boolean") return value === "true" ? "Yes" : "No";
  if (definition.dataType === "date") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
  }
  return definition.unit ? `${value} ${definition.unit}` : value;
}
