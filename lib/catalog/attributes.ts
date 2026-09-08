import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  productAttributes,
  variantOptionValues,
} from "@/db/schema";
import { requireStaff } from "@/lib/auth/authorize";
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
) {
  requireStaff(actor);

  return db.transaction(async (tx) => {
    const [attribute] = await tx
      .insert(attributes)
      .values({ name: input.name, inputType: input.inputType })
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
  requireStaff(actor);

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
  requireStaff(actor);

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
  requireStaff(actor);

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
  requireStaff(actor);

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
