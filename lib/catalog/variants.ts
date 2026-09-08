import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  productAttributes,
  productVariants,
  products,
  variantOptionValues,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  buildSku,
  combinationKey,
  diffCombinations,
  generateCombinations,
  type AttributeAxis,
  type Combination,
} from "./combinations";

export type VariantRow = {
  id: string;
  sku: string;
  label: string;
  priceBdt: number;
  isEnabled: boolean;
  fulfillmentMode: string;
  stockQuantity: number | null;
  preorderCapacity: number | null;
  preorderReserved: number;
  preorderClosesAt: Date | null;
  estimatedArrivalFrom: Date | null;
  estimatedArrivalTo: Date | null;
  paymentMode: string;
  depositPercent: number | null;
  archivedAt: Date | null;
};

/** The axes a product varies by, with every value that could be chosen. */
export async function getProductAxes(productId: string): Promise<AttributeAxis[]> {
  const rows = await db
    .select({
      attributeId: attributes.id,
      name: attributes.name,
      sortOrder: productAttributes.sortOrder,
      valueId: attributeValues.id,
      value: attributeValues.value,
      valueSortOrder: attributeValues.sortOrder,
    })
    .from(productAttributes)
    .innerJoin(attributes, eq(productAttributes.attributeId, attributes.id))
    .leftJoin(
      attributeValues,
      eq(attributeValues.attributeId, attributes.id),
    )
    .where(eq(productAttributes.productId, productId))
    .orderBy(
      asc(productAttributes.sortOrder),
      asc(attributeValues.sortOrder),
      asc(attributeValues.value),
    );

  const axes = new Map<string, AttributeAxis>();

  for (const row of rows) {
    if (!axes.has(row.attributeId)) {
      axes.set(row.attributeId, {
        attributeId: row.attributeId,
        name: row.name,
        values: [],
      });
    }
    if (row.valueId && row.value) {
      axes.get(row.attributeId)!.values.push({
        id: row.valueId,
        value: row.value,
      });
    }
  }

  return [...axes.values()];
}

/** Combination keys of the variants a product already has. */
async function existingCombinationKeys(
  productId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      variantId: productVariants.id,
      attributeId: variantOptionValues.attributeId,
      attributeValueId: variantOptionValues.attributeValueId,
    })
    .from(productVariants)
    .leftJoin(
      variantOptionValues,
      eq(variantOptionValues.variantId, productVariants.id),
    )
    .where(eq(productVariants.productId, productId));

  const byVariant = new Map<
    string,
    { attributeId: string; attributeValueId: string }[]
  >();

  for (const row of rows) {
    if (!row.attributeId || !row.attributeValueId) continue;
    const options = byVariant.get(row.variantId) ?? [];
    options.push({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
    });
    byVariant.set(row.variantId, options);
  }

  const keyToVariant = new Map<string, string>();
  for (const [variantId, options] of byVariant) {
    keyToVariant.set(combinationKey(options), variantId);
  }

  return keyToVariant;
}

export type GenerateResult = {
  created: number;
  unchanged: number;
  orphaned: number;
};

/**
 * Generates any variant combinations the product is missing.
 *
 * Existing variants are never touched: they carry prices, preorder capacity,
 * and can be referenced by orders. Combinations that no longer exist are
 * reported, not deleted, for the same reason — removing them would erase what
 * a past order actually bought.
 */
export async function generateVariants(
  actor: SessionUser | null,
  productId: string,
  defaults: { priceBdt: number; fulfillmentMode?: "in_stock" | "preorder" } = {
    priceBdt: 0,
  },
): Promise<GenerateResult> {
  const staff = requireStaff(actor);

  const axes = await getProductAxes(productId);

  // A product that varies by nothing still needs something to sell. One plain
  // variant, created once: calling again returns it unchanged rather than
  // stacking up duplicates.
  if (axes.length === 0) {
    return createSingleVariant(staff, productId, defaults);
  }

  const generated = generateCombinations(axes);
  const existing = await existingCombinationKeys(productId);

  const diff = diffCombinations(generated, [...existing.keys()]);

  if (diff.toCreate.length === 0) {
    return {
      created: 0,
      unchanged: diff.unchanged.length,
      orphaned: diff.orphanedKeys.length,
    };
  }

  const [product] = await db
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.id, productId));

  await db.transaction(async (tx) => {
    // Read the SKUs already in use once, rather than querying per combination.
    const takenSkus = new Set(
      (
        await tx.select({ sku: productVariants.sku }).from(productVariants)
      ).map((row) => row.sku),
    );

    for (const combination of diff.toCreate) {
      const sku = nextFreeSku(product.slug, combination, takenSkus);
      takenSkus.add(sku);

      const [variant] = await tx
        .insert(productVariants)
        .values({
          productId,
          sku,
          priceBdt: defaults.priceBdt,
          fulfillmentMode: defaults.fulfillmentMode ?? "preorder",
          isEnabled: true,
        })
        .returning({ id: productVariants.id });

      await tx.insert(variantOptionValues).values(
        combination.options.map((option) => ({
          variantId: variant.id,
          attributeId: option.attributeId,
          attributeValueId: option.attributeValueId,
        })),
      );
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.created",
        entityType: "product",
        entityId: productId,
        after: {
          created: diff.toCreate.length,
          labels: diff.toCreate.map((c) => c.label),
        },
      },
      tx,
    );
  });

  return {
    created: diff.toCreate.length,
    unchanged: diff.unchanged.length,
    orphaned: diff.orphanedKeys.length,
  };
}

/**
 * The no-variations case: one variant carrying no option values, which
 * `listVariants` labels "Single variant". Idempotent, because the wizard's
 * generate button is the kind of thing people press twice.
 */
async function createSingleVariant(
  staff: SessionUser,
  productId: string,
  defaults: { priceBdt: number; fulfillmentMode?: "in_stock" | "preorder" },
): Promise<GenerateResult> {
  const existing = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  if (existing.length > 0) {
    return { created: 0, unchanged: existing.length, orphaned: 0 };
  }

  const [product] = await db
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.id, productId));

  if (!product) throw new Error("That product no longer exists.");

  await db.transaction(async (tx) => {
    const takenSkus = new Set(
      (await tx.select({ sku: productVariants.sku }).from(productVariants)).map(
        (row) => row.sku,
      ),
    );

    const base = product.slug.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
    let sku = base;
    for (let attempt = 1; takenSkus.has(sku); attempt++) {
      sku = `${base}-${attempt + 1}`;
    }

    await tx.insert(productVariants).values({
      productId,
      sku,
      priceBdt: defaults.priceBdt,
      fulfillmentMode: defaults.fulfillmentMode ?? "preorder",
      isEnabled: true,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.created",
        entityType: "product",
        entityId: productId,
        after: { created: 1, labels: ["Single variant"] },
      },
      tx,
    );
  });

  return { created: 1, unchanged: 0, orphaned: 0 };
}

/** Picks the first SKU not already spoken for, against an in-memory set. */
function nextFreeSku(
  productSlug: string,
  combination: Combination,
  taken: Set<string>,
): string {
  const base = buildSku(productSlug, combination);

  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`Could not find an unused SKU based on "${base}".`);
}

export async function listVariants(
  actor: SessionUser | null,
  productId: string,
): Promise<VariantRow[]> {
  requireStaff(actor);

  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.sku));

  const optionRows = await db
    .select({
      variantId: variantOptionValues.variantId,
      value: attributeValues.value,
      sortOrder: productAttributes.sortOrder,
    })
    .from(variantOptionValues)
    .innerJoin(
      attributeValues,
      eq(variantOptionValues.attributeValueId, attributeValues.id),
    )
    .innerJoin(
      productAttributes,
      and(
        eq(productAttributes.attributeId, variantOptionValues.attributeId),
        eq(productAttributes.productId, productId),
      ),
    )
    .where(
      inArray(
        variantOptionValues.variantId,
        variants.map((variant) => variant.id),
      ),
    )
    .orderBy(asc(productAttributes.sortOrder));

  return variants.map((variant) => ({
    id: variant.id,
    sku: variant.sku,
    label:
      optionRows
        .filter((row) => row.variantId === variant.id)
        .map((row) => row.value)
        .join(" / ") || "Single variant",
    priceBdt: variant.priceBdt,
    isEnabled: variant.isEnabled,
    fulfillmentMode: variant.fulfillmentMode,
    stockQuantity: variant.stockQuantity,
    preorderCapacity: variant.preorderCapacity,
    preorderReserved: variant.preorderReserved,
    preorderClosesAt: variant.preorderClosesAt,
    estimatedArrivalFrom: variant.estimatedArrivalFrom,
    estimatedArrivalTo: variant.estimatedArrivalTo,
    paymentMode: variant.paymentMode,
    depositPercent: variant.depositPercent,
    archivedAt: variant.archivedAt,
  }));
}

export type VariantUpdate = {
  priceBdt?: number;
  costPriceUsd?: number | null;
  isEnabled?: boolean;
  fulfillmentMode?: "in_stock" | "preorder";
  stockQuantity?: number | null;
  preorderCapacity?: number | null;
  preorderClosesAt?: Date | null;
  paymentMode?: "full" | "deposit";
  depositPercent?: number | null;
  estimatedArrivalFrom?: Date | null;
  estimatedArrivalTo?: Date | null;
  weightGrams?: number | null;
};

export class CapacityBelowReservedError extends Error {
  readonly status = 409;

  constructor(reserved: number) {
    super(
      `Capacity cannot be set below the ${reserved} slot${reserved === 1 ? "" : "s"} already reserved.`,
    );
    this.name = "CapacityBelowReservedError";
  }
}

/**
 * Updates one variant. Capacity may never be set below what is already
 * reserved: those slots are sold, and lowering the ceiling under them would
 * mean the site has taken more preorders than it can fulfil.
 */
export async function updateVariant(
  actor: SessionUser | null,
  variantId: string,
  update: VariantUpdate,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

    if (!before) throw new Error("That variant no longer exists.");

    if (
      update.preorderCapacity !== undefined &&
      update.preorderCapacity !== null &&
      update.preorderCapacity < before.preorderReserved
    ) {
      throw new CapacityBelowReservedError(before.preorderReserved);
    }

    const [updated] = await tx
      .update(productVariants)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(productVariants.id, variantId))
      .returning();

    const priceChanged =
      update.priceBdt !== undefined && update.priceBdt !== before.priceBdt;
    const capacityChanged =
      update.preorderCapacity !== undefined &&
      update.preorderCapacity !== before.preorderCapacity;

    // Price and capacity changes are called out explicitly, because
    // MASTER_PRODUCT_SPEC.md section 4 names them as the sensitive ones.
    await recordAudit(
      {
        actorUserId: staff.id,
        action: priceChanged
          ? "product.price_changed"
          : capacityChanged
            ? "variant.capacity_changed"
            : "variant.updated",
        entityType: "variant",
        entityId: variantId,
        before: {
          priceBdt: before.priceBdt,
          preorderCapacity: before.preorderCapacity,
          isEnabled: before.isEnabled,
        },
        after: {
          priceBdt: updated.priceBdt,
          preorderCapacity: updated.preorderCapacity,
          isEnabled: updated.isEnabled,
        },
      },
      tx,
    );

    return updated;
  });
}

/** Applies one change to many variants at once, each still audited. */
export async function bulkUpdateVariants(
  actor: SessionUser | null,
  variantIds: string[],
  update: VariantUpdate,
): Promise<number> {
  requireStaff(actor);

  let updated = 0;
  for (const variantId of variantIds) {
    await updateVariant(actor, variantId, update);
    updated += 1;
  }
  return updated;
}

/**
 * Disabling is how an unwanted generated combination is taken off sale. The
 * row stays, so an order that referenced it still resolves.
 */
export async function setVariantEnabled(
  actor: SessionUser | null,
  variantId: string,
  isEnabled: boolean,
) {
  return updateVariant(actor, variantId, { isEnabled });
}

/** Variants a shopper may actually buy. */
export async function listPurchasableVariants(productId: string) {
  return db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      priceBdt: productVariants.priceBdt,
      fulfillmentMode: productVariants.fulfillmentMode,
      stockQuantity: productVariants.stockQuantity,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      preorderClosesAt: productVariants.preorderClosesAt,
      estimatedArrivalFrom: productVariants.estimatedArrivalFrom,
      estimatedArrivalTo: productVariants.estimatedArrivalTo,
      paymentMode: productVariants.paymentMode,
      depositPercent: productVariants.depositPercent,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    )
    .orderBy(asc(productVariants.sku));
}

/** Remaining preorder slots, or null when the variant is not a preorder. */
export function remainingCapacity(variant: {
  fulfillmentMode: string;
  preorderCapacity: number | null;
  preorderReserved: number;
}): number | null {
  if (variant.fulfillmentMode !== "preorder") return null;
  if (variant.preorderCapacity === null) return null;
  return Math.max(0, variant.preorderCapacity - variant.preorderReserved);
}

export async function countVariants(productId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  return row.value;
}
