import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  cartItems,
  inventoryAdjustments,
  orderItems,
  productAttributes,
  productImages,
  productVariants,
  products,
  variantImages,
  variantOptionValues,
  waitlistEntries,
  wishlistItems,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
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
  /** The regular price. A live sale is `salePriceBdt` within its window. */
  priceBdt: number;
  salePriceBdt: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  lowStockThreshold: number | null;
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
  /** The variant's own photograph, when one is chosen. */
  imageUrl: string | null;
  imageId: string | null;
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
  /** Outdated variants removed (archived where ordered) when pruning. */
  removed?: number;
};

/**
 * Removes live variants that no longer match any combination of the
 * product's options — the plain variant once a first group is added, or the
 * one-group variants once a second group is added. Each goes through
 * removeVariant, so a variant with order history is archived, not deleted.
 */
async function pruneOutdatedVariants(
  staff: SessionUser,
  productId: string,
  generated: Combination[],
): Promise<number> {
  const keys = new Set(generated.map((combination) => combination.key));
  const existing = await existingCombinationKeys(productId);
  const keyOf = new Map([...existing].map(([key, variantId]) => [variantId, key]));
  const live = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)));

  let removed = 0;
  for (const variant of live) {
    if (keys.has(keyOf.get(variant.id) ?? "")) continue;
    await removeVariant(staff, variant.id);
    removed += 1;
  }
  return removed;
}

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
  defaults: {
    priceBdt: number;
    fulfillmentMode?: "in_stock" | "preorder";
    /** Also remove variants that no longer match the options (the editor). */
    prune?: boolean;
  } = {
    priceBdt: 0,
  },
): Promise<GenerateResult> {
  const staff = requirePermission(actor, "catalog.manage");

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
    const removed = defaults.prune ? await pruneOutdatedVariants(staff, productId, generated) : 0;
    return {
      created: 0,
      unchanged: diff.unchanged.length,
      orphaned: diff.orphanedKeys.length,
      removed,
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

  const removed = defaults.prune ? await pruneOutdatedVariants(staff, productId, generated) : 0;

  return {
    created: diff.toCreate.length,
    unchanged: diff.unchanged.length,
    orphaned: diff.orphanedKeys.length,
    removed,
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
  // Live variants only: a product whose variants were all archived (removed
  // with order history) still needs one it can sell.
  const existing = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)));

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
  requirePermission(actor, "catalog.manage");

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

  const photos =
    variants.length === 0
      ? []
      : await db
          .select({ variantId: variantImages.variantId, url: variantImages.url })
          .from(variantImages)
          .where(inArray(variantImages.variantId, variants.map((variant) => variant.id)))
          .orderBy(asc(variantImages.sortOrder));
  const gallery =
    variants.length === 0
      ? []
      : await db
          .select({ id: productImages.id, url: productImages.url })
          .from(productImages)
          .where(eq(productImages.productId, productId));

  return variants.map((variant) => ({
    imageUrl: photos.find((photo) => photo.variantId === variant.id)?.url ?? null,
    imageId:
      gallery.find((image) => image.url === photos.find((photo) => photo.variantId === variant.id)?.url)?.id ??
      null,
    id: variant.id,
    sku: variant.sku,
    label:
      optionRows
        .filter((row) => row.variantId === variant.id)
        .map((row) => row.value)
        .join(" / ") || "Single variant",
    priceBdt: variant.priceBdt,
    salePriceBdt: variant.salePriceBdt,
    saleStartsAt: variant.saleStartsAt,
    saleEndsAt: variant.saleEndsAt,
    lowStockThreshold: variant.lowStockThreshold,
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
  sku?: string;
  priceBdt?: number;
  salePriceBdt?: number | null;
  saleStartsAt?: Date | null;
  saleEndsAt?: Date | null;
  lowStockThreshold?: number | null;
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

/** A price or a SKU the admin can fix, said in a sentence rather than as a
    constraint violation from the database. */
export class VariantPricingError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "VariantPricingError";
  }
}

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
  const staff = requirePermission(actor, "catalog.manage");

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

    /*
     * A sale is checked against whichever regular price this save leaves in
     * place, not only against the one sent with it. Raising a sale price and
     * lowering the regular price in two separate saves would otherwise slip
     * past a check that only compared the two fields when both arrived.
     */
    const regular = update.priceBdt ?? before.priceBdt;
    const sale =
      update.salePriceBdt !== undefined ? update.salePriceBdt : before.salePriceBdt;

    if (sale !== null && sale > regular) {
      throw new VariantPricingError(
        "A sale price cannot be higher than the regular price.",
      );
    }

    const saleStarts =
      update.saleStartsAt !== undefined ? update.saleStartsAt : before.saleStartsAt;
    const saleEnds =
      update.saleEndsAt !== undefined ? update.saleEndsAt : before.saleEndsAt;

    if (saleStarts && saleEnds && saleEnds <= saleStarts) {
      throw new VariantPricingError("A sale has to end after it starts.");
    }

    if (update.sku !== undefined && update.sku !== before.sku) {
      const [clash] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.sku, update.sku))
        .limit(1);

      if (clash && clash.id !== variantId) {
        throw new VariantPricingError(
          `The SKU ${update.sku} already belongs to another variant.`,
        );
      }
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
  requirePermission(actor, "catalog.manage");

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

/**
 * Adds one variant by hand — "Blue / XL" — rather than generating every
 * combination. A value typed that the option does not have yet ("Teal") is
 * added to the option, so staff never have to leave this screen for it.
 */
export async function addVariant(
  actor: SessionUser | null,
  productId: string,
  input: {
    options: { attributeId: string; value: string }[];
    priceBdt: number;
    fulfillmentMode: "in_stock" | "preorder";
  },
): Promise<{ id: string; sku: string; label: string }> {
  const staff = requirePermission(actor, "catalog.manage");

  const [product] = await db
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.id, productId));
  if (!product) throw new VariantPricingError("That product no longer exists.");

  const axes = await db
    .select({ attributeId: productAttributes.attributeId, name: attributes.name })
    .from(productAttributes)
    .innerJoin(attributes, eq(productAttributes.attributeId, attributes.id))
    .where(eq(productAttributes.productId, productId))
    .orderBy(asc(productAttributes.sortOrder));

  if (axes.length === 0) {
    const [live] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)))
      .limit(1);
    if (live) {
      throw new VariantPricingError(
        "This product has no options, so it has one variant. Add an option such as Colour or Size first.",
      );
    }
  }

  const chosen = axes.map((axis) => {
    const value = input.options.find((option) => option.attributeId === axis.attributeId)?.value.trim();
    if (!value) throw new VariantPricingError(`Choose a ${axis.name.toLowerCase()}.`);
    if (value.length > 120) throw new VariantPricingError(`${axis.name} is too long.`);
    return { ...axis, value };
  });

  const existing = await existingCombinationKeys(productId);

  return db.transaction(async (tx) => {
    const options: { attributeId: string; attributeValueId: string; value: string }[] = [];

    for (const axis of chosen) {
      const [found] = await tx
        .select({ id: attributeValues.id, value: attributeValues.value })
        .from(attributeValues)
        .where(
          and(
            eq(attributeValues.attributeId, axis.attributeId),
            sql`lower(${attributeValues.value}) = lower(${axis.value})`,
          ),
        )
        .limit(1);

      if (found) {
        options.push({ attributeId: axis.attributeId, attributeValueId: found.id, value: found.value });
        continue;
      }

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${attributeValues.sortOrder}) + 1, 0)::int` })
        .from(attributeValues)
        .where(eq(attributeValues.attributeId, axis.attributeId));
      const [created] = await tx
        .insert(attributeValues)
        .values({ attributeId: axis.attributeId, value: axis.value, sortOrder: Number(next) })
        .returning({ id: attributeValues.id });
      options.push({ attributeId: axis.attributeId, attributeValueId: created.id, value: axis.value });
    }

    if (options.length > 0 && existing.has(combinationKey(options))) {
      throw new VariantPricingError(
        "That combination already exists. Edit it, or restore it if it was deleted.",
      );
    }

    const label = options.map((option) => option.value).join(" / ") || "Single variant";
    const taken = new Set(
      (await tx.select({ sku: productVariants.sku }).from(productVariants)).map((row) => row.sku),
    );
    const base = [product.slug, ...options.map((option) => option.value)]
      .join("-")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56);
    let sku = base;
    for (let attempt = 2; taken.has(sku); attempt++) sku = `${base}-${attempt}`;

    const [variant] = await tx
      .insert(productVariants)
      .values({
        productId,
        sku,
        priceBdt: input.priceBdt,
        fulfillmentMode: input.fulfillmentMode,
        isEnabled: true,
      })
      .returning({ id: productVariants.id });

    if (options.length > 0) {
      await tx.insert(variantOptionValues).values(
        options.map((option) => ({
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
        after: { created: 1, labels: [label], sku },
      },
      tx,
    );

    return { id: variant.id, sku, label };
  });
}

/**
 * Removes a variant. One that nothing has ever referenced — no order, no
 * stock movement, no waitlist, no reserved places — is deleted outright. One
 * with history is archived instead: taken off sale and hidden, but kept, so a
 * past order still says what was bought (CLAUDE.md section 7).
 */
export async function removeVariant(
  actor: SessionUser | null,
  variantId: string,
): Promise<{ mode: "deleted" | "archived" }> {
  const staff = requirePermission(actor, "catalog.manage");

  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    if (!variant) throw new VariantPricingError("That variant no longer exists.");

    const count = async (query: Promise<{ n: number }[]>) => Number((await query)[0]?.n ?? 0);
    const history =
      (await count(
        tx.select({ n: sql<number>`count(*)::int` }).from(orderItems).where(eq(orderItems.variantId, variantId)),
      )) +
      (await count(
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(inventoryAdjustments)
          .where(eq(inventoryAdjustments.variantId, variantId)),
      )) +
      (await count(
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(waitlistEntries)
          .where(eq(waitlistEntries.variantId, variantId)),
      ));

    if (history > 0 || variant.preorderReserved > 0) {
      await tx
        .update(productVariants)
        .set({ archivedAt: new Date(), isEnabled: false, updatedAt: new Date() })
        .where(eq(productVariants.id, variantId));
      await recordAudit(
        {
          actorUserId: staff.id,
          action: "variant.archived",
          entityType: "variant",
          entityId: variantId,
          before: { sku: variant.sku },
        },
        tx,
      );
      return { mode: "archived" as const };
    }

    await tx.delete(cartItems).where(eq(cartItems.variantId, variantId));
    await tx.delete(wishlistItems).where(eq(wishlistItems.variantId, variantId));
    await tx.delete(variantImages).where(eq(variantImages.variantId, variantId));
    await tx.delete(variantOptionValues).where(eq(variantOptionValues.variantId, variantId));
    await tx.delete(productVariants).where(eq(productVariants.id, variantId));
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.deleted",
        entityType: "variant",
        entityId: variantId,
        before: { sku: variant.sku, productId: variant.productId },
      },
      tx,
    );
    return { mode: "deleted" as const };
  });
}

/**
 * Gives a variant its own photograph — one of the product's photographs — or
 * clears it with null. The storefront shows it when that variant is chosen.
 */
export async function setVariantImage(
  actor: SessionUser | null,
  variantId: string,
  imageId: string | null,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [variant] = await db
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  if (!variant) throw new VariantPricingError("That variant no longer exists.");

  await db.transaction(async (tx) => {
    await tx.delete(variantImages).where(eq(variantImages.variantId, variantId));
    if (imageId) {
      const [image] = await tx
        .select()
        .from(productImages)
        .where(and(eq(productImages.id, imageId), eq(productImages.productId, variant.productId)));
      if (!image) throw new VariantPricingError("That photograph does not belong to this product.");
      await tx
        .insert(variantImages)
        .values({ variantId, url: image.url, altText: image.altText, sortOrder: 0 });
    }
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.updated",
        entityType: "variant",
        entityId: variantId,
        after: { imageId },
      },
      tx,
    );
  });
}

/** Brings an archived variant back, switched on. */
export async function restoreVariant(actor: SessionUser | null, variantId: string) {
  const staff = requirePermission(actor, "catalog.manage");
  const [restored] = await db
    .update(productVariants)
    .set({ archivedAt: null, isEnabled: true, updatedAt: new Date() })
    .where(eq(productVariants.id, variantId))
    .returning({ id: productVariants.id });
  if (!restored) throw new VariantPricingError("That variant no longer exists.");
  await recordAudit({
    actorUserId: staff.id,
    action: "variant.restored",
    entityType: "variant",
    entityId: variantId,
  });
  return restored;
}

export async function countVariants(productId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  return row.value;
}
