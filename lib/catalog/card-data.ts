import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages, productVariants, reviews } from "@/db/schema";

/**
 * Per-product aggregates for a product card, fetched for a whole page of
 * products at once.
 *
 * These began life as correlated subqueries inside the product select. Drizzle
 * drops the table qualifier on a column whose table is not part of the outer
 * query, so `product_images.product_id = products.id` rendered as
 * `"product_id" = "id"` — a comparison of two columns of the same table, which
 * is never true. Every card silently lost its photo and its rating. Separate
 * queries keyed by product id are longer but cannot fail that way, and it is
 * still a fixed number of queries rather than one per product.
 */

export type CardAggregate = {
  imageUrl: string | null;
  imageAlt: string | null;
  fromPriceBdt: number | null;
  fulfillmentMode: string | null;
  remainingCapacity: number | null;
  /**
   * Every slot in the batch, taken or not. Null when nothing is capped.
   *
   * The card needs both numbers, not just the remainder: "7 left" says nothing
   * about urgency until you know whether the batch holds 8 or 800.
   */
  totalCapacity: number | null;
  closesAt: Date | null;
  /** The preorder window shuts within three days. Decided in SQL. */
  closingSoon: boolean;
  arrivesFrom: Date | null;
  arrivesTo: Date | null;
  ratingAverage: number | null;
  reviewCount: number;
};

const EMPTY: CardAggregate = {
  imageUrl: null,
  imageAlt: null,
  fromPriceBdt: null,
  fulfillmentMode: null,
  remainingCapacity: null,
  totalCapacity: null,
  closesAt: null,
  closingSoon: false,
  arrivesFrom: null,
  arrivesTo: null,
  ratingAverage: null,
  reviewCount: 0,
};

export async function loadCardAggregates(
  productIds: string[],
): Promise<Map<string, CardAggregate>> {
  const result = new Map<string, CardAggregate>();
  if (productIds.length === 0) return result;

  for (const id of productIds) result.set(id, { ...EMPTY });

  // First image per product, by sort order.
  const images = await db
    .selectDistinctOn([productImages.productId], {
      productId: productImages.productId,
      url: productImages.url,
      altText: productImages.altText,
    })
    .from(productImages)
    .where(inArray(productImages.productId, productIds))
    .orderBy(productImages.productId, productImages.sortOrder);

  for (const image of images) {
    const entry = result.get(image.productId);
    if (!entry) continue;
    entry.imageUrl = image.url;
    entry.imageAlt = image.altText;
  }

  // Price, availability, and dates across the purchasable variants.
  const variants = await db
    .select({
      productId: productVariants.productId,
      minPrice: sql<number>`min(${productVariants.priceBdt})::int`,
      remaining: sql<number | null>`sum(
        greatest(0, ${productVariants.preorderCapacity} - ${productVariants.preorderReserved})
      )::int`,
      capacity: sql<number | null>`sum(${productVariants.preorderCapacity})::int`,
      closesAt: sql<Date | null>`max(${productVariants.preorderClosesAt})`,
      /* Whether the window shuts within three days, decided by the database so
         there is one clock for the whole system — the same reason
         getPublicVariants computes isClosed in SQL. */
      closingSoon: sql<boolean>`bool_or(
        ${productVariants.preorderClosesAt} > now()
        and ${productVariants.preorderClosesAt} < now() + interval '3 days'
      )`,
      arrivesFrom: sql<Date | null>`min(${productVariants.estimatedArrivalFrom})`,
      arrivesTo: sql<Date | null>`max(${productVariants.estimatedArrivalTo})`,
      anyPreorder: sql<boolean>`bool_or(${productVariants.fulfillmentMode} = 'preorder')`,
    })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    )
    .groupBy(productVariants.productId);

  for (const variant of variants) {
    const entry = result.get(variant.productId);
    if (!entry) continue;
    entry.fromPriceBdt = Number(variant.minPrice);
    entry.fulfillmentMode = variant.anyPreorder ? "preorder" : "in_stock";
    entry.remainingCapacity =
      variant.remaining === null ? null : Number(variant.remaining);
    entry.totalCapacity =
      variant.capacity === null ? null : Number(variant.capacity);
    entry.closesAt = variant.closesAt ? new Date(variant.closesAt) : null;
    entry.closingSoon = Boolean(variant.closingSoon);
    entry.arrivesFrom = variant.arrivesFrom
      ? new Date(variant.arrivesFrom)
      : null;
    entry.arrivesTo = variant.arrivesTo ? new Date(variant.arrivesTo) : null;
  }

  // Approved reviews only — pending ones must not move the public average.
  const ratings = await db
    .select({
      productId: reviews.productId,
      average: sql<string>`round(avg(${reviews.rating})::numeric, 1)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(
      and(
        inArray(reviews.productId, productIds),
        eq(reviews.status, "approved"),
      ),
    )
    .groupBy(reviews.productId);

  for (const rating of ratings) {
    const entry = result.get(rating.productId);
    if (!entry) continue;
    entry.ratingAverage = Number(rating.average);
    entry.reviewCount = Number(rating.count);
  }

  return result;
}
