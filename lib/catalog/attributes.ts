import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  productAttributes,
  productVariants,
  variantOptionValues,
} from "@/db/schema";
import { removeVariant } from "./variants";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { AttributeInputPayload } from "@/lib/validation/catalog";

export type AttributeWithValues = {
  id: string;
  name: string;
  inputType: string;
  values: { id: string; value: string; sortOrder: number }[];
};

export class AttributeInUseError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AttributeInUseError";
  }
}

export async function listAttributes(): Promise<AttributeWithValues[]> {
  const attributeRows = await db
    .select()
    .from(attributes)
    .orderBy(asc(attributes.name));

  const valueRows = await db
    .select()
    .from(attributeValues)
    .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.value));

  return attributeRows.map((attribute) => ({
    id: attribute.id,
    name: attribute.name,
    inputType: attribute.inputType,
    values: valueRows
      .filter((value) => value.attributeId === attribute.id)
      .map((value) => ({
        id: value.id,
        value: value.value,
        sortOrder: value.sortOrder,
      })),
  }));
}

export async function createAttribute(
  actor: SessionUser | null,
  input: AttributeInputPayload,
  /** The owning product. Null creates a legacy shared option (tests only). */
  productId: string | null = null,
) {
  requirePermission(actor, "catalog.manage");

  return db.transaction(async (tx) => {
    const [attribute] = await tx
      .insert(attributes)
      .values({ name: input.name, inputType: input.inputType, productId })
      .returning();

    if (input.values?.length) {
      await tx.insert(attributeValues).values(
        input.values.map((value, index) => ({
          attributeId: attribute.id,
          value,
          sortOrder: index,
        })),
      );
    }

    return attribute;
  });
}

export async function addAttributeValue(
  actor: SessionUser | null,
  attributeId: string,
  value: string,
) {
  requirePermission(actor, "catalog.manage");

  const [{ nextOrder }] = await db
    .select({
      nextOrder: sql<number>`coalesce(max(${attributeValues.sortOrder}) + 1, 0)::int`,
    })
    .from(attributeValues)
    .where(eq(attributeValues.attributeId, attributeId));

  const [created] = await db
    .insert(attributeValues)
    .values({ attributeId, value, sortOrder: nextOrder })
    .returning();

  return created;
}

/**
 * A value that a variant already uses cannot be removed: doing so would erase
 * what a purchased variant actually was.
 */
export async function deleteAttributeValue(
  actor: SessionUser | null,
  valueId: string,
) {
  requirePermission(actor, "catalog.manage");

  const [{ inUse }] = await db
    .select({ inUse: sql<number>`count(*)::int` })
    .from(variantOptionValues)
    .where(eq(variantOptionValues.attributeValueId, valueId));

  if (inUse > 0) {
    throw new AttributeInUseError(
      `${inUse} variant${inUse === 1 ? " uses" : "s use"} this value. Remove those variants first.`,
    );
  }

  await db.delete(attributeValues).where(eq(attributeValues.id, valueId));
}

export async function deleteAttribute(
  actor: SessionUser | null,
  attributeId: string,
) {
  requirePermission(actor, "catalog.manage");

  const [{ inUse }] = await db
    .select({ inUse: sql<number>`count(*)::int` })
    .from(productAttributes)
    .where(eq(productAttributes.attributeId, attributeId));

  if (inUse > 0) {
    throw new AttributeInUseError(
      `${inUse} product${inUse === 1 ? " uses" : "s use"} this attribute. Remove it from them first.`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(attributeValues)
      .where(eq(attributeValues.attributeId, attributeId));
    await tx.delete(attributes).where(eq(attributes.id, attributeId));
  });
}

// ------------------------------------------------------------------
// Product-owned options (D-040). An option — "Color" with White, Grey — is
// created on one product and belongs to it alone: another product never sees
// it, and removing a value affects only this product's variants.

export type ProductOption = {
  id: string;
  name: string;
  values: { id: string; value: string; sortOrder: number }[];
};

export class ProductOptionError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProductOptionError";
    this.status = status;
  }
}

/** The options this product varies by, with their values, in order. */
export async function listProductOptions(productId: string): Promise<ProductOption[]> {
  const rows = await db
    .select({ id: attributes.id, name: attributes.name, sortOrder: productAttributes.sortOrder })
    .from(attributes)
    .leftJoin(
      productAttributes,
      and(eq(productAttributes.attributeId, attributes.id), eq(productAttributes.productId, productId)),
    )
    .where(eq(attributes.productId, productId))
    .orderBy(asc(productAttributes.sortOrder), asc(attributes.name));

  if (rows.length === 0) return [];

  // Named in full inside the subqueries: a bare "id" there would mean the
  // variant's own id (the bug noted in lib/catalog/products.ts).
  const valueId = sql.raw(`"attribute_values"."id"`);
  const values = await db
    .select({
      id: attributeValues.id,
      attributeId: attributeValues.attributeId,
      value: attributeValues.value,
      sortOrder: attributeValues.sortOrder,
      live: sql<number>`(select count(*)::int from variant_option_values vov
        join product_variants v on v.id = vov.variant_id
        where vov.attribute_value_id = ${valueId} and v.archived_at is null)`,
      archived: sql<number>`(select count(*)::int from variant_option_values vov
        join product_variants v on v.id = vov.variant_id
        where vov.attribute_value_id = ${valueId} and v.archived_at is not null)`,
    })
    .from(attributeValues)
    .where(inArray(attributeValues.attributeId, rows.map((row) => row.id)))
    .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.value));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    values: values
      // A value kept only for an archived (ordered) variant is not offered.
      .filter((value) => value.attributeId === row.id && !(Number(value.live) === 0 && Number(value.archived) > 0))
      .map((value) => ({ id: value.id, value: value.value, sortOrder: value.sortOrder })),
  }));
}

/** Adds an option with its values to one product. */
export async function createProductOption(
  actor: SessionUser | null,
  productId: string,
  input: { name: string; values: string[] },
) {
  requirePermission(actor, "catalog.manage");
  const name = input.name.trim();
  if (!name) throw new ProductOptionError("Name the option — Color, Size, Capacity.");

  const [clash] = await db
    .select({ id: attributes.id })
    .from(attributes)
    .where(and(eq(attributes.productId, productId), sql`lower(${attributes.name}) = lower(${name})`))
    .limit(1);
  if (clash) throw new ProductOptionError(`This product already has an option called “${name}”.`, 409);

  const values = [
    ...new Map(
      input.values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [value.toLowerCase(), value] as const),
    ).values(),
  ];

  return db.transaction(async (tx) => {
    const [attribute] = await tx
      .insert(attributes)
      .values({ name, inputType: "select", productId })
      .returning();
    if (values.length > 0) {
      await tx.insert(attributeValues).values(
        values.map((value, index) => ({ attributeId: attribute.id, value, sortOrder: index })),
      );
    }
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${productAttributes.sortOrder}) + 1, 0)::int` })
      .from(productAttributes)
      .where(eq(productAttributes.productId, productId));
    await tx
      .insert(productAttributes)
      .values({ productId, attributeId: attribute.id, sortOrder: Number(next) });
    return attribute;
  });
}

/**
 * Removes one value from a product's option, with the variants that carry
 * it. Only this product is affected. A variant with order history is archived
 * rather than deleted, and the value stays on record for it.
 */
export async function removeProductOptionValue(actor: SessionUser | null, valueId: string) {
  requirePermission(actor, "catalog.manage");

  const [row] = await db
    .select({ productId: attributes.productId })
    .from(attributeValues)
    .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
    .where(eq(attributeValues.id, valueId));
  if (!row) throw new ProductOptionError("That value no longer exists.", 404);

  // A legacy shared option keeps the old rule: refused while in use.
  if (!row.productId) {
    await deleteAttributeValue(actor, valueId);
    return { deleted: 0, archived: 0 };
  }

  const variants = await db
    .select({ id: variantOptionValues.variantId })
    .from(variantOptionValues)
    .where(eq(variantOptionValues.attributeValueId, valueId));

  let deleted = 0;
  let archived = 0;
  for (const variant of variants) {
    const result = await removeVariant(actor, variant.id);
    if (result.mode === "deleted") deleted += 1;
    else archived += 1;
  }

  const [{ still }] = await db
    .select({ still: sql<number>`count(*)::int` })
    .from(variantOptionValues)
    .where(eq(variantOptionValues.attributeValueId, valueId));
  if (Number(still) === 0) {
    await db.delete(attributeValues).where(eq(attributeValues.id, valueId));
  }
  return { deleted, archived };
}

/**
 * Removes a whole option from a product. Every variant carries a value for
 * each option, so the product's variants go with it (archived where ordered);
 * the editor then regenerates from the options that remain.
 */
export async function removeProductOption(
  actor: SessionUser | null,
  productId: string,
  attributeId: string,
) {
  requirePermission(actor, "catalog.manage");

  const [attribute] = await db
    .select({ id: attributes.id, productId: attributes.productId })
    .from(attributes)
    .where(eq(attributes.id, attributeId));
  if (!attribute || attribute.productId !== productId) {
    throw new ProductOptionError("That option does not belong to this product.", 404);
  }

  const variants = await db
    .selectDistinct({ id: variantOptionValues.variantId })
    .from(variantOptionValues)
    .innerJoin(productVariants, eq(productVariants.id, variantOptionValues.variantId))
    .where(and(eq(variantOptionValues.attributeId, attributeId), eq(productVariants.productId, productId)));

  let deleted = 0;
  let archived = 0;
  for (const variant of variants) {
    const result = await removeVariant(actor, variant.id);
    if (result.mode === "deleted") deleted += 1;
    else archived += 1;
  }

  await db
    .delete(productAttributes)
    .where(and(eq(productAttributes.productId, productId), eq(productAttributes.attributeId, attributeId)));

  const [{ still }] = await db
    .select({ still: sql<number>`count(*)::int` })
    .from(variantOptionValues)
    .where(eq(variantOptionValues.attributeId, attributeId));
  if (Number(still) === 0) {
    await db.delete(attributeValues).where(eq(attributeValues.attributeId, attributeId));
    await db.delete(attributes).where(eq(attributes.id, attributeId));
  }
  return { deleted, archived };
}

/** Which attributes a product varies by, in display order. */
export async function getProductAttributes(productId: string) {
  return db
    .select({
      attributeId: productAttributes.attributeId,
      name: attributes.name,
      sortOrder: productAttributes.sortOrder,
    })
    .from(productAttributes)
    .innerJoin(attributes, eq(productAttributes.attributeId, attributes.id))
    .where(eq(productAttributes.productId, productId))
    .orderBy(asc(productAttributes.sortOrder));
}

export async function setProductAttributes(
  actor: SessionUser | null,
  productId: string,
  attributeIds: string[],
) {
  requirePermission(actor, "catalog.manage");

  await db.transaction(async (tx) => {
    await tx
      .delete(productAttributes)
      .where(eq(productAttributes.productId, productId));

    if (attributeIds.length > 0) {
      await tx.insert(productAttributes).values(
        attributeIds.map((attributeId, index) => ({
          productId,
          attributeId,
          sortOrder: index,
        })),
      );
    }
  });
}
