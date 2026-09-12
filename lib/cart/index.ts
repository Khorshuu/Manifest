import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { effectivePriceSql } from "@/lib/catalog/price";
import {
  loadVariantOptions,
  summariseOptions,
  type VariantOption,
} from "@/lib/catalog/variant-options";
import {
  cartItems,
  carts,
  productImages,
  productVariants,
  products,
  variantImages,
} from "@/db/schema";

/**
 * The cart.
 *
 * Cart rows store a variant and a quantity — never a price. Every total is
 * recomputed from the live variant on each read, so a stale or tampered price
 * cannot be carried into checkout (docs/BUSINESS_LOGIC.md).
 */

export type CartLine = {
  itemId: string;
  variantId: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  /** "Pearl White · 3-Seater", or "" for a product with no options. */
  optionSummary: string;
  /** The same choice as named pairs, for the checkout summary. */
  options: VariantOption[];
  /** The variant's SKU, shown where the exact version matters. */
  sku: string;
  imageUrl: string | null;
  imageAlt: string;
  quantity: number;
  unitPriceBdt: number;
  lineTotalBdt: number;
  fulfillmentMode: string;
  paymentMode: string;
  depositPercent: number | null;
  /** Remaining slots or stock; null when nothing limits it. */
  available: number | null;
  /** Why this line cannot be checked out, if it cannot. */
  problem: string | null;
};

export type CartView = {
  cartId: string;
  lines: CartLine[];
  subtotalBdt: number;
  /** Sum of what is due at placement, honouring deposit variants. */
  dueNowBdt: number;
  hasProblems: boolean;
};

export class CartNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("That cart no longer exists.");
    this.name = "CartNotFoundError";
  }
}

export function newCartToken(): string {
  return randomUUID();
}

/** Finds or creates the cart for a session token, or a signed-in user. */
export async function getOrCreateCart(options: {
  userId?: string | null;
  sessionToken?: string | null;
}): Promise<string> {
  if (options.userId) {
    const [existing] = await db
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.userId, options.userId))
      .limit(1);

    if (existing) return existing.id;

    const [created] = await db
      .insert(carts)
      .values({ userId: options.userId })
      .returning({ id: carts.id });
    return created.id;
  }

  if (!options.sessionToken) {
    throw new Error("A guest cart needs a session token.");
  }

  const [existing] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.sessionToken, options.sessionToken))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(carts)
    .values({ sessionToken: options.sessionToken })
    .returning({ id: carts.id });

  return created.id;
}

/**
 * Reads the cart with live prices and availability.
 *
 * Every line reports its own problem rather than the cart failing as a whole,
 * so a shopper can see exactly which item changed.
 */
export async function getCartView(cartId: string): Promise<CartView> {
  const rows = await db
    .select({
      itemId: cartItems.id,
      variantId: cartItems.variantId,
      quantity: cartItems.quantity,
      productId: products.id,
      productTitle: products.title,
      productSlug: products.slug,
      productStatus: products.status,
      productArchivedAt: products.archivedAt,
      /* Priced by the server, from the sale window as the database sees it. */
      sku: productVariants.sku,
      unitPriceBdt: effectivePriceSql,
      fulfillmentMode: productVariants.fulfillmentMode,
      paymentMode: productVariants.paymentMode,
      depositPercent: productVariants.depositPercent,
      isEnabled: productVariants.isEnabled,
      variantArchivedAt: productVariants.archivedAt,
      stockQuantity: productVariants.stockQuantity,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      isClosed: sql<boolean>`(${productVariants.preorderClosesAt} is not null
        and ${productVariants.preorderClosesAt} <= now())`,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(cartItems.addedAt);

  const variantIds = rows.map((row) => row.variantId);
  const productIds = rows.map((row) => row.productId);

  const [options, variantPhotos, images] = await Promise.all([
    loadVariantOptions(variantIds),
    // The chosen variant's own photograph wins over the product's first one:
    // a cart line showing the white sofa for a grey one bought is the whole
    // complaint this change answers.
    variantIds.length
      ? db
          .selectDistinctOn([variantImages.variantId], {
            variantId: variantImages.variantId,
            url: variantImages.url,
            altText: variantImages.altText,
          })
          .from(variantImages)
          .where(inArray(variantImages.variantId, variantIds))
          .orderBy(variantImages.variantId, variantImages.sortOrder)
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

  const lines: CartLine[] = rows.map((row) => {
    const productImage = images.find(
      (entry) => entry.productId === row.productId,
    );
    const variantPhoto = variantPhotos.find(
      (entry) => entry.variantId === row.variantId,
    );
    const image = variantPhoto ?? productImage;
    const variantOptions = options.get(row.variantId) ?? [];

    const available =
      row.fulfillmentMode === "preorder"
        ? row.preorderCapacity === null
          ? null
          : Math.max(0, row.preorderCapacity - row.preorderReserved)
        : row.stockQuantity;

    let problem: string | null = null;
    if (row.productArchivedAt || row.variantArchivedAt || !row.isEnabled) {
      problem = "This item is no longer sold.";
    } else if (row.isClosed) {
      problem = "This preorder has closed.";
    } else if (available !== null && available <= 0) {
      problem =
        row.fulfillmentMode === "preorder"
          ? "This preorder is now full."
          : "This item is out of stock.";
    } else if (available !== null && available < row.quantity) {
      problem = `Only ${available} left — reduce the quantity to continue.`;
    }

    const unitPriceBdt = row.unitPriceBdt;

    return {
      itemId: row.itemId,
      variantId: row.variantId,
      productId: row.productId,
      productTitle: row.productTitle,
      productSlug: row.productSlug,
      optionSummary: summariseOptions(variantOptions),
      options: variantOptions,
      sku: row.sku,
      imageUrl: image?.url ?? null,
      imageAlt: image?.altText ?? row.productTitle,
      quantity: row.quantity,
      unitPriceBdt,
      lineTotalBdt: unitPriceBdt * row.quantity,
      fulfillmentMode: row.fulfillmentMode,
      paymentMode: row.paymentMode,
      depositPercent: row.depositPercent,
      available,
      problem,
    };
  });

  const subtotalBdt = lines.reduce((sum, line) => sum + line.lineTotalBdt, 0);

  // A deposit line contributes only its deposit to what is due at placement.
  const dueNowBdt = lines.reduce((sum, line) => {
    if (line.paymentMode === "deposit" && line.depositPercent) {
      return sum + Math.round((line.lineTotalBdt * line.depositPercent) / 100);
    }
    return sum + line.lineTotalBdt;
  }, 0);

  return {
    cartId,
    lines,
    subtotalBdt,
    dueNowBdt,
    hasProblems: lines.some((line) => line.problem !== null),
  };
}

export class VariantUnavailableError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "VariantUnavailableError";
  }
}

/**
 * Adds a variant, or increases the quantity if it is already there.
 *
 * This checks availability for a quick, honest response, but it is not the
 * authoritative check — that happens under a lock at checkout. A cart is not a
 * reservation.
 */
export async function addToCart(
  cartId: string,
  variantId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }

  const [variant] = await db
    .select({
      id: productVariants.id,
      isEnabled: productVariants.isEnabled,
      archivedAt: productVariants.archivedAt,
      fulfillmentMode: productVariants.fulfillmentMode,
      stockQuantity: productVariants.stockQuantity,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      isClosed: sql<boolean>`(${productVariants.preorderClosesAt} is not null
        and ${productVariants.preorderClosesAt} <= now())`,
      productArchivedAt: products.archivedAt,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant) throw new VariantUnavailableError("That item was not found.");

  if (variant.archivedAt || variant.productArchivedAt || !variant.isEnabled) {
    throw new VariantUnavailableError("That item is no longer sold.");
  }

  if (variant.isClosed) {
    throw new VariantUnavailableError("That preorder has closed.");
  }

  const available =
    variant.fulfillmentMode === "preorder"
      ? variant.preorderCapacity === null
        ? null
        : Math.max(0, variant.preorderCapacity - variant.preorderReserved)
      : variant.stockQuantity;

  if (available !== null && available <= 0) {
    throw new VariantUnavailableError(
      variant.fulfillmentMode === "preorder"
        ? "That preorder is full."
        : "That item is out of stock.",
    );
  }

  const [existing] = await db
    .select({ id: cartItems.id, quantity: cartItems.quantity })
    .from(cartItems)
    .where(
      and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)),
    )
    .limit(1);

  const desired = (existing?.quantity ?? 0) + quantity;

  if (available !== null && desired > available) {
    throw new VariantUnavailableError(
      `Only ${available} available. Your cart already holds ${existing?.quantity ?? 0}.`,
    );
  }

  if (existing) {
    await db
      .update(cartItems)
      .set({ quantity: desired })
      .where(eq(cartItems.id, existing.id));
    return;
  }

  await db.insert(cartItems).values({ cartId, variantId, quantity });
}

export async function updateCartItem(
  cartId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) {
    await removeCartItem(cartId, itemId);
    return;
  }

  await db
    .update(cartItems)
    .set({ quantity })
    // Scoped to the cart, so an item id from another cart cannot be touched.
    .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cartId)));
}

export async function removeCartItem(
  cartId: string,
  itemId: string,
): Promise<void> {
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cartId)));
}

export async function clearCart(cartId: string): Promise<void> {
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
}

export async function countCartItems(cartId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${cartItems.quantity}), 0)::int` })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));

  return row.value;
}

/**
 * Merges a guest cart into the signed-in user's cart on login. Where both hold
 * the same variant the higher quantity wins, per MASTER_PRODUCT_SPEC.md §5.4.
 */
export async function mergeGuestCart(
  guestSessionToken: string,
  userId: string,
): Promise<void> {
  const [guestCart] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.sessionToken, guestSessionToken))
    .limit(1);

  if (!guestCart) return;

  const userCartId = await getOrCreateCart({ userId });
  if (userCartId === guestCart.id) return;

  const guestLines = await db
    .select({ variantId: cartItems.variantId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.cartId, guestCart.id));

  const userLines = await db
    .select({
      id: cartItems.id,
      variantId: cartItems.variantId,
      quantity: cartItems.quantity,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, userCartId));

  for (const line of guestLines) {
    const match = userLines.find((own) => own.variantId === line.variantId);

    if (!match) {
      await db.insert(cartItems).values({
        cartId: userCartId,
        variantId: line.variantId,
        quantity: line.quantity,
      });
      continue;
    }

    if (line.quantity > match.quantity) {
      await db
        .update(cartItems)
        .set({ quantity: line.quantity })
        .where(eq(cartItems.id, match.id));
    }
  }

  await db.delete(cartItems).where(eq(cartItems.cartId, guestCart.id));
  await db.delete(carts).where(eq(carts.id, guestCart.id));
}

/** Cart lines that can actually be checked out. */
export async function getCheckoutableLines(cartId: string) {
  const view = await getCartView(cartId);
  return view.lines.filter((line) => line.problem === null);
}

export async function cartExists(cartId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.id, cartId), isNull(carts.userId)))
    .limit(1);
  return Boolean(row);
}
