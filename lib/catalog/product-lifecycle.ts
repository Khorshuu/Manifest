import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributes,
  attributeValues,
  cartItems,
  inventoryAdjustments,
  orderItems,
  productAttributes,
  productCategories,
  productImages,
  productRelated,
  products,
  productVariants,
  reviews,
  seoResearchRuns,
  skuReservations,
  variantImages,
  variantOptionValues,
  waitlistEntries,
  wishlistItems,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { uniqueSlug } from "@/lib/slug";
import { slugTaken } from "./products";

/**
 * Unpublish, duplicate and delete — the lifecycle actions the product list and
 * editor offer beside publish and archive.
 *
 * Delete is only for a product nothing has ever depended on. One with orders,
 * reviews, stock movements, a waitlist or reserved places is refused with the
 * reason, and Archive is the answer: it comes off sale and past orders stay
 * intact (CLAUDE.md section 7).
 */

export class ProductLifecycleError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "ProductLifecycleError";
    this.status = status;
  }
}

/**
 * The live status a product is published as when nobody chooses one: a
 * preorder listing opens for preorders, anything else is in stock.
 */
export async function inferLiveStatus(
  productId: string,
): Promise<"preorder_open" | "in_stock"> {
  const [row] = await db
    .select({
      preorders: sql<number>`count(*) filter (where ${productVariants.fulfillmentMode} = 'preorder')::int`,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        isNull(productVariants.archivedAt),
        eq(productVariants.isEnabled, true),
      ),
    );
  return Number(row?.preorders ?? 0) > 0 ? "preorder_open" : "in_stock";
}

/** Takes a live product off the storefront by returning it to draft. */
export async function unpublishProduct(actor: SessionUser | null, productId: string) {
  const staff = requirePermission(actor, "catalog.manage");

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: products.status, archivedAt: products.archivedAt })
      .from(products)
      .where(eq(products.id, productId));
    if (!before) throw new ProductLifecycleError("That product no longer exists.", 404);
    if (before.archivedAt) {
      throw new ProductLifecycleError("This product is archived. Restore it instead.");
    }

    const [updated] = await tx
      .update(products)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(products.id, productId))
      .returning({ id: products.id, status: products.status });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        before: { status: before.status },
        after: { status: "draft", unpublished: true },
      },
      tx,
    );
    return updated;
  });
}

/**
 * Copies a product as a new draft: its details, photographs, categories,
 * options and variants. What must stay unique is not copied — the SKU and
 * trade identifier are cleared and variant SKUs get a suffix — and nothing
 * sold is carried over: no reserved places, no stock on hand.
 */
export async function duplicateProduct(actor: SessionUser | null, productId: string) {
  const staff = requirePermission(actor, "catalog.manage");

  const [source] = await db.select().from(products).where(eq(products.id, productId));
  if (!source) throw new ProductLifecycleError("That product no longer exists.", 404);

  const title = `${source.title} (copy)`.slice(0, 200);
  const slug = await uniqueSlug(title, (candidate) => slugTaken(candidate));

  return db.transaction(async (tx) => {
    const values: Partial<typeof source> = { ...source };
    delete values.id;
    delete values.createdAt;
    delete values.updatedAt;

    const [copy] = await tx
      .insert(products)
      .values({
        ...(values as typeof products.$inferInsert),
        title,
        slug,
        sku: null,
        identifierType: null,
        identifierValue: null,
        status: "draft",
        archivedAt: null,
        publishAt: null,
        unpublishAt: null,
      })
      .returning({ id: products.id, slug: products.slug, title: products.title });

    const images = await tx.select().from(productImages).where(eq(productImages.productId, productId));
    if (images.length > 0) {
      await tx.insert(productImages).values(
        images.map((image) => ({
          productId: copy.id,
          url: image.url,
          altText: image.altText,
          sortOrder: image.sortOrder,
          kind: image.kind,
        })),
      );
    }

    const secondary = await tx
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, productId));
    if (secondary.length > 0) {
      await tx
        .insert(productCategories)
        .values(secondary.map((row) => ({ productId: copy.id, categoryId: row.categoryId })));
    }

    // Options are product-owned (D-040): the copy gets its own copies of them,
    // so editing the copy's colours can never touch the original's.
    const axes = await tx.select().from(productAttributes).where(eq(productAttributes.productId, productId));
    const attributeMap = new Map<string, string>();
    const valueMap = new Map<string, string>();
    for (const axis of axes) {
      const [source] = await tx.select().from(attributes).where(eq(attributes.id, axis.attributeId));
      let targetId = axis.attributeId;
      if (source?.productId) {
        const [cloned] = await tx
          .insert(attributes)
          .values({ name: source.name, inputType: source.inputType, productId: copy.id })
          .returning({ id: attributes.id });
        targetId = cloned.id;
        const values = await tx.select().from(attributeValues).where(eq(attributeValues.attributeId, source.id));
        for (const value of values) {
          const [clonedValue] = await tx
            .insert(attributeValues)
            .values({ attributeId: cloned.id, value: value.value, sortOrder: value.sortOrder })
            .returning({ id: attributeValues.id });
          valueMap.set(value.id, clonedValue.id);
        }
      }
      attributeMap.set(axis.attributeId, targetId);
      await tx.insert(productAttributes).values({ productId: copy.id, attributeId: targetId, sortOrder: axis.sortOrder });
    }

    const variants = await tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)));
    const taken = new Set(
      (await tx.select({ sku: productVariants.sku }).from(productVariants)).map((row) => row.sku),
    );

    for (const variant of variants) {
      const base = `${variant.sku}-COPY`.slice(0, 60);
      let sku = base;
      for (let attempt = 2; taken.has(sku); attempt++) sku = `${base}-${attempt}`;
      taken.add(sku);

      const variantValues: Partial<typeof variant> = { ...variant };
      delete variantValues.id;
      delete variantValues.createdAt;
      delete variantValues.updatedAt;

      const [created] = await tx
        .insert(productVariants)
        .values({
          ...(variantValues as typeof productVariants.$inferInsert),
          productId: copy.id,
          sku,
          preorderReserved: 0,
          stockQuantity: variant.fulfillmentMode === "in_stock" ? 0 : variant.stockQuantity,
        })
        .returning({ id: productVariants.id });

      const options = await tx
        .select()
        .from(variantOptionValues)
        .where(eq(variantOptionValues.variantId, variant.id));
      if (options.length > 0) {
        await tx.insert(variantOptionValues).values(
          options.map((option) => ({
            variantId: created.id,
            attributeId: attributeMap.get(option.attributeId) ?? option.attributeId,
            attributeValueId: valueMap.get(option.attributeValueId) ?? option.attributeValueId,
          })),
        );
      }

      // The variant's own photograph comes along (it points at a shared file).
      const photos = await tx.select().from(variantImages).where(eq(variantImages.variantId, variant.id));
      if (photos.length > 0) {
        await tx.insert(variantImages).values(
          photos.map((photo) => ({
            variantId: created.id,
            url: photo.url,
            altText: photo.altText,
            sortOrder: photo.sortOrder,
          })),
        );
      }
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.duplicated",
        entityType: "product",
        entityId: copy.id,
        after: { duplicatedFrom: productId, title },
      },
      tx,
    );

    return copy;
  });
}

async function countWhere(query: Promise<{ n: number }[]>): Promise<number> {
  return Number((await query)[0]?.n ?? 0);
}

/**
 * Deletes a product permanently — only when nothing has ever depended on it.
 * Otherwise refuses and says why; archiving is the safe alternative.
 */
export async function deleteProduct(actor: SessionUser | null, productId: string) {
  const staff = requirePermission(actor, "catalog.manage");

  return db.transaction(async (tx) => {
    const [product] = await tx
      .select({ id: products.id, title: products.title, slug: products.slug, sku: products.sku })
      .from(products)
      .where(eq(products.id, productId));
    if (!product) throw new ProductLifecycleError("That product no longer exists.", 404);

    const variants = await tx
      .select({ id: productVariants.id, reserved: productVariants.preorderReserved })
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
    const variantIds = variants.map((variant) => variant.id);
    const count = sql<number>`count(*)::int`;

    const history =
      variants.reduce((sum, variant) => sum + variant.reserved, 0) +
      (await countWhere(tx.select({ n: count }).from(reviews).where(eq(reviews.productId, productId)))) +
      (variantIds.length === 0
        ? 0
        : (await countWhere(
            tx.select({ n: count }).from(orderItems).where(inArray(orderItems.variantId, variantIds)),
          )) +
          (await countWhere(
            tx
              .select({ n: count })
              .from(inventoryAdjustments)
              .where(inArray(inventoryAdjustments.variantId, variantIds)),
          )) +
          (await countWhere(
            tx.select({ n: count }).from(waitlistEntries).where(inArray(waitlistEntries.variantId, variantIds)),
          )));

    if (history > 0) {
      throw new ProductLifecycleError(
        `“${product.title}” has orders, reviews, stock history or reservations, so it cannot be deleted. Archive it instead — it comes off sale and past orders stay intact.`,
      );
    }

    if (variantIds.length > 0) {
      await tx.delete(cartItems).where(inArray(cartItems.variantId, variantIds));
      await tx.delete(wishlistItems).where(inArray(wishlistItems.variantId, variantIds));
      await tx.delete(variantImages).where(inArray(variantImages.variantId, variantIds));
      await tx.delete(variantOptionValues).where(inArray(variantOptionValues.variantId, variantIds));
      await tx.delete(productVariants).where(inArray(productVariants.id, variantIds));
    }
    await tx.delete(productAttributes).where(eq(productAttributes.productId, productId));
    // Its own options go with it (D-040); their values are only its own.
    const owned = (
      await tx.select({ id: attributes.id }).from(attributes).where(eq(attributes.productId, productId))
    ).map((row) => row.id);
    if (owned.length > 0) {
      await tx.delete(attributeValues).where(inArray(attributeValues.attributeId, owned));
      await tx.delete(attributes).where(inArray(attributes.id, owned));
    }
    await tx.delete(productImages).where(eq(productImages.productId, productId));
    await tx.delete(productCategories).where(eq(productCategories.productId, productId));
    await tx
      .delete(productRelated)
      .where(or(eq(productRelated.productId, productId), eq(productRelated.relatedProductId, productId)));
    await tx.delete(seoResearchRuns).where(eq(seoResearchRuns.productId, productId));
    // The SKU stays spent: its reservation row is kept, detached from the product.
    await tx.update(skuReservations).set({ productId: null }).where(eq(skuReservations.productId, productId));
    await tx.delete(products).where(eq(products.id, productId));

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.deleted",
        entityType: "product",
        entityId: productId,
        before: { title: product.title, slug: product.slug, sku: product.sku },
      },
      tx,
    );

    return { id: productId };
  });
}
