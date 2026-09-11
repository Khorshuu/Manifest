import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  cartItems,
  productImages,
  productVariants,
  products,
  variantOptionValues,
  wishlistItems,
} from "@/db/schema";
import { requireUser, type SessionUser } from "@/lib/auth";
import { addToCart, VariantUnavailableError } from "@/lib/cart";
import { effectivePriceSql } from "@/lib/catalog/price";

/**
 * The wishlist, and "save for later" in the cart, which is the same list.
 *
 * A wishlist row is a variant and an owner — never a price. What it costs and
 * whether it can be bought are read live on every render, exactly as the cart
 * does, so a saved item cannot carry a stale price anywhere.
 *
 * Accounts only: a guest has no durable identity to keep a list against, and
 * the product page sends them to sign in instead (DECISIONS.md D-031).
 */

export type WishlistEntry = {
  variantId: string;
  productTitle: string;
  productSlug: string;
  optionSummary: string;
  imageUrl: string | null;
  imageAlt: string;
  priceBdt: number;
  fulfillmentMode: string;
  /** Why it cannot go into the cart right now, or null when it can. */
  problem: string | null;
  savedAt: Date;
};

export async function addToWishlist(
  actor: SessionUser | null,
  variantId: string,
): Promise<void> {
  const user = requireUser(actor);

  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(productVariants.id, variantId),
        sql`${productVariants.archivedAt} is null`,
        sql`${products.archivedAt} is null`,
        sql`${products.status} not in ('draft', 'archived', 'scheduled')`,
      ),
    )
    .limit(1);

  if (!variant) throw new VariantUnavailableError("That item was not found.");

  // Saving twice is not an error: the unique pair makes it a no-op.
  await db
    .insert(wishlistItems)
    .values({ userId: user.id, variantId })
    .onConflictDoNothing();
}

export async function removeFromWishlist(
  actor: SessionUser | null,
  variantId: string,
): Promise<void> {
  const user = requireUser(actor);

  await db
    .delete(wishlistItems)
    // Scoped to the owner, so nobody can empty another account's list.
    .where(
      and(
        eq(wishlistItems.userId, user.id),
        eq(wishlistItems.variantId, variantId),
      ),
    );
}

/** Which of these variants the account has saved — for the buy box toggle. */
export async function listSavedVariantIds(
  userId: string,
  variantIds: string[],
): Promise<string[]> {
  if (variantIds.length === 0) return [];

  const rows = await db
    .select({ variantId: wishlistItems.variantId })
    .from(wishlistItems)
    .where(
      and(
        eq(wishlistItems.userId, userId),
        inArray(wishlistItems.variantId, variantIds),
      ),
    );

  return rows.map((row) => row.variantId);
}

export async function listWishlist(userId: string): Promise<WishlistEntry[]> {
  const rows = await db
    .select({
      variantId: wishlistItems.variantId,
      savedAt: wishlistItems.createdAt,
      productId: products.id,
      productTitle: products.title,
      productSlug: products.slug,
      productStatus: products.status,
      productArchivedAt: products.archivedAt,
      priceBdt: effectivePriceSql,
      fulfillmentMode: productVariants.fulfillmentMode,
      isEnabled: productVariants.isEnabled,
      variantArchivedAt: productVariants.archivedAt,
      stockQuantity: productVariants.stockQuantity,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      isClosed: sql<boolean>`(${productVariants.preorderClosesAt} is not null
        and ${productVariants.preorderClosesAt} <= now())`,
    })
    .from(wishlistItems)
    .innerJoin(productVariants, eq(wishlistItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(wishlistItems.userId, userId))
    .orderBy(desc(wishlistItems.createdAt));

  const variantIds = rows.map((row) => row.variantId);
  const productIds = rows.map((row) => row.productId);

  const [options, images] = await Promise.all([
    variantIds.length
      ? db
          .select({
            variantId: variantOptionValues.variantId,
            value: attributeValues.value,
          })
          .from(variantOptionValues)
          .innerJoin(
            attributeValues,
            eq(variantOptionValues.attributeValueId, attributeValues.id),
          )
          .where(inArray(variantOptionValues.variantId, variantIds))
      : Promise.resolve([]),
    productIds.length
      ? db
          .selectDistinctOn([productImages.productId], {
            productId: productImages.productId,
            url: productImages.url,
            altText: productImages.altText,
          })
          .from(productImages)
          .where(inArray(productImages.productId, productIds))
          .orderBy(productImages.productId, productImages.sortOrder)
      : Promise.resolve([]),
  ]);

  return rows.map((row) => {
    const image = images.find((entry) => entry.productId === row.productId);
    const available =
      row.fulfillmentMode === "preorder"
        ? row.preorderCapacity === null
          ? null
          : Math.max(0, row.preorderCapacity - row.preorderReserved)
        : row.stockQuantity;

    let problem: string | null = null;
    if (
      row.productArchivedAt ||
      row.variantArchivedAt ||
      !row.isEnabled ||
      row.productStatus === "draft" ||
      row.productStatus === "discontinued"
    ) {
      problem = "No longer sold.";
    } else if (row.isClosed) {
      problem = "This preorder has closed.";
    } else if (available !== null && available <= 0) {
      problem =
        row.fulfillmentMode === "preorder"
          ? "This preorder is full."
          : "Out of stock.";
    }

    return {
      variantId: row.variantId,
      productTitle: row.productTitle,
      productSlug: row.productSlug,
      optionSummary:
        options
          .filter((option) => option.variantId === row.variantId)
          .map((option) => option.value)
          .join(" / ") || "Standard",
      imageUrl: image?.url ?? null,
      imageAlt: image?.altText ?? row.productTitle,
      priceBdt: row.priceBdt,
      fulfillmentMode: row.fulfillmentMode,
      problem,
      savedAt: row.savedAt,
    };
  });
}

export async function countWishlist(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId));
  return Number(row?.value ?? 0);
}

/**
 * Moves a cart line onto the wishlist. The line is found through the cart it
 * belongs to, so an item id from someone else's cart matches nothing.
 */
export async function saveCartItemForLater(
  actor: SessionUser | null,
  cartId: string,
  itemId: string,
): Promise<void> {
  const user = requireUser(actor);

  await db.transaction(async (tx) => {
    const [line] = await tx
      .select({ variantId: cartItems.variantId })
      .from(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cartId)))
      .limit(1);

    if (!line) return;

    await tx
      .insert(wishlistItems)
      .values({ userId: user.id, variantId: line.variantId })
      .onConflictDoNothing();

    await tx
      .delete(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cartId)));
  });
}

/**
 * Moves a saved item into the cart, one of it. The cart's own availability
 * check runs first, and the item stays saved if that refuses it.
 */
export async function moveWishlistItemToCart(
  actor: SessionUser | null,
  cartId: string,
  variantId: string,
): Promise<void> {
  const user = requireUser(actor);

  const [saved] = await db
    .select({ id: wishlistItems.id })
    .from(wishlistItems)
    .where(
      and(
        eq(wishlistItems.userId, user.id),
        eq(wishlistItems.variantId, variantId),
      ),
    )
    .limit(1);

  if (!saved) throw new VariantUnavailableError("That item is not saved.");

  await addToCart(cartId, variantId, 1);
  await db.delete(wishlistItems).where(eq(wishlistItems.id, saved.id));
}
