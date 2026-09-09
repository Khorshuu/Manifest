import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { queueWaitlistNotifications } from "@/lib/notifications/waitlist";
import { productVariants, waitlistEntries } from "@/db/schema";

/**
 * Preorder capacity.
 *
 * This is the one place in the system where a race condition has a direct
 * financial consequence: two shoppers taking the same last slot means the
 * business has sold something it cannot deliver. Every reservation therefore
 * locks the variant row and re-checks the remaining capacity inside the same
 * transaction, never as a read followed by a separate write.
 */

export type VariantAvailability = {
  variantId: string;
  fulfillmentMode: "in_stock" | "preorder";
  /** Null when nothing limits it: an in-stock variant, or uncapped preorder. */
  remaining: number | null;
  isPurchasable: boolean;
  reason:
    | "available"
    | "disabled"
    | "archived"
    | "sold_out"
    | "window_closed"
    | "out_of_stock";
};

export class CapacityUnavailableError extends Error {
  readonly status = 409;

  constructor(
    message: string,
    readonly reason: VariantAvailability["reason"],
    readonly remaining: number,
  ) {
    super(message);
    this.name = "CapacityUnavailableError";
  }
}

export class VariantNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("That item is no longer available.");
    this.name = "VariantNotFoundError";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the base
   database or an open transaction; they differ only in generics */
type Executor = any;

type VariantRow = {
  id: string;
  isEnabled: boolean;
  archivedAt: Date | null;
  fulfillmentMode: string;
  stockQuantity: number | null;
  preorderCapacity: number | null;
  preorderReserved: number;
  preorderClosesAt: Date | null;
};

function evaluate(variant: VariantRow, now: Date): VariantAvailability {
  const base = {
    variantId: variant.id,
    fulfillmentMode: variant.fulfillmentMode as "in_stock" | "preorder",
  };

  if (variant.archivedAt) {
    return { ...base, remaining: 0, isPurchasable: false, reason: "archived" };
  }

  if (!variant.isEnabled) {
    return { ...base, remaining: 0, isPurchasable: false, reason: "disabled" };
  }

  if (variant.fulfillmentMode === "in_stock") {
    const remaining = variant.stockQuantity;
    if (remaining !== null && remaining <= 0) {
      return { ...base, remaining: 0, isPurchasable: false, reason: "out_of_stock" };
    }
    return { ...base, remaining, isPurchasable: true, reason: "available" };
  }

  // The window closes on a date, on capacity, or both.
  if (variant.preorderClosesAt && variant.preorderClosesAt.getTime() <= now.getTime()) {
    return {
      ...base,
      remaining: 0,
      isPurchasable: false,
      reason: "window_closed",
    };
  }

  if (variant.preorderCapacity === null) {
    return { ...base, remaining: null, isPurchasable: true, reason: "available" };
  }

  const remaining = Math.max(
    0,
    variant.preorderCapacity - variant.preorderReserved,
  );

  if (remaining <= 0) {
    return { ...base, remaining: 0, isPurchasable: false, reason: "sold_out" };
  }

  return { ...base, remaining, isPurchasable: true, reason: "available" };
}

/**
 * Availability for display. This is advisory only — a shopper may see it and
 * check out a moment later, so the authoritative check is the locked one in
 * `reserveCapacity`.
 */
export async function getAvailability(
  variantId: string,
  now: Date = new Date(),
): Promise<VariantAvailability> {
  const [variant] = await db
    .select({
      id: productVariants.id,
      isEnabled: productVariants.isEnabled,
      archivedAt: productVariants.archivedAt,
      fulfillmentMode: productVariants.fulfillmentMode,
      stockQuantity: productVariants.stockQuantity,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      preorderClosesAt: productVariants.preorderClosesAt,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant) throw new VariantNotFoundError();

  return evaluate(variant, now);
}

const REASON_MESSAGES: Record<VariantAvailability["reason"], string> = {
  available: "",
  disabled: "That option is no longer sold.",
  archived: "That item is no longer available.",
  sold_out: "That preorder is full.",
  window_closed: "That preorder has closed.",
  out_of_stock: "That item is out of stock.",
};

/**
 * Reserves capacity for one variant inside an open transaction.
 *
 * The caller must supply the transaction: reserving capacity and creating the
 * order must commit or fail together, or the site can hold slots for orders
 * that were never placed.
 */
export async function reserveCapacity(
  tx: Executor,
  variantId: string,
  quantity: number,
  now: Date = new Date(),
): Promise<{ remainingAfter: number | null }> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Quantity must be a positive whole number, got ${quantity}.`);
  }

  // Lock the row for the rest of the transaction. Anyone else reserving this
  // variant waits here rather than reading a value that is about to change.
  const locked = await tx.execute(sql`
    select id, is_enabled, archived_at, fulfillment_mode, stock_quantity,
           preorder_capacity, preorder_reserved, preorder_closes_at
    from product_variants
    where id = ${variantId}
    for update
  `);

  const row = (Array.isArray(locked) ? locked[0] : locked.rows?.[0]) as
    | Record<string, unknown>
    | undefined;

  if (!row) throw new VariantNotFoundError();

  const variant: VariantRow = {
    id: String(row.id),
    isEnabled: Boolean(row.is_enabled),
    archivedAt: row.archived_at ? new Date(String(row.archived_at)) : null,
    fulfillmentMode: String(row.fulfillment_mode),
    stockQuantity:
      row.stock_quantity === null ? null : Number(row.stock_quantity),
    preorderCapacity:
      row.preorder_capacity === null ? null : Number(row.preorder_capacity),
    preorderReserved: Number(row.preorder_reserved),
    preorderClosesAt: row.preorder_closes_at
      ? new Date(String(row.preorder_closes_at))
      : null,
  };

  const availability = evaluate(variant, now);

  if (!availability.isPurchasable) {
    throw new CapacityUnavailableError(
      REASON_MESSAGES[availability.reason],
      availability.reason,
      0,
    );
  }

  if (availability.remaining !== null && availability.remaining < quantity) {
    throw new CapacityUnavailableError(
      `Only ${availability.remaining} left.`,
      variant.fulfillmentMode === "preorder" ? "sold_out" : "out_of_stock",
      availability.remaining,
    );
  }

  if (variant.fulfillmentMode === "preorder") {
    await tx
      .update(productVariants)
      .set({
        preorderReserved: sql`${productVariants.preorderReserved} + ${quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(productVariants.id, variantId));

    return {
      remainingAfter:
        availability.remaining === null ? null : availability.remaining - quantity,
    };
  }

  await tx
    .update(productVariants)
    .set({
      stockQuantity: sql`${productVariants.stockQuantity} - ${quantity}`,
      updatedAt: new Date(),
    })
    .where(eq(productVariants.id, variantId));

  return {
    remainingAfter:
      availability.remaining === null ? null : availability.remaining - quantity,
  };
}

/**
 * Returns capacity to a variant — a cancelled order, or a batch that was
 * never purchased. Clamped at zero so a double release cannot drive the
 * reserved count negative.
 */
export async function releaseCapacity(
  tx: Executor,
  variantId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Quantity must be a positive whole number, got ${quantity}.`);
  }

  const locked = await tx.execute(sql`
    select fulfillment_mode from product_variants where id = ${variantId} for update
  `);
  const row = (Array.isArray(locked) ? locked[0] : locked.rows?.[0]) as
    | Record<string, unknown>
    | undefined;

  if (!row) throw new VariantNotFoundError();

  if (String(row.fulfillment_mode) === "preorder") {
    await tx
      .update(productVariants)
      .set({
        preorderReserved: sql`greatest(0, ${productVariants.preorderReserved} - ${quantity})`,
        updatedAt: new Date(),
      })
      .where(eq(productVariants.id, variantId));

    /*
     * Somebody cancelled, so the places they held are open again. The people
     * waiting are told inside this transaction, so a message exists if and
     * only if the capacity really came back — and no place is held for them
     * (DECISIONS.md D-011).
     */
    await queueWaitlistNotifications(tx, variantId, quantity);
    return;
  }

  await tx
    .update(productVariants)
    .set({
      stockQuantity: sql`coalesce(${productVariants.stockQuantity}, 0) + ${quantity}`,
      updatedAt: new Date(),
    })
    .where(eq(productVariants.id, variantId));
}

/** Convenience wrapper that opens its own transaction. */
export async function reserveCapacityStandalone(
  variantId: string,
  quantity: number,
  now: Date = new Date(),
) {
  return db.transaction((tx) => reserveCapacity(tx, variantId, quantity, now));
}

export async function releaseCapacityStandalone(
  variantId: string,
  quantity: number,
) {
  return db.transaction((tx) => releaseCapacity(tx, variantId, quantity));
}

/**
 * Joins the waitlist for a variant that is full. One entry per email per
 * variant, so a repeated attempt does not create duplicates.
 */
export async function joinWaitlist(
  variantId: string,
  email: string,
  userId: string | null = null,
): Promise<{ alreadyOnList: boolean }> {
  const existing = await db
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.variantId, variantId),
        eq(waitlistEntries.email, email),
        sql`${waitlistEntries.notifiedAt} is null`,
      ),
    )
    .limit(1);

  if (existing.length > 0) return { alreadyOnList: true };

  await db.insert(waitlistEntries).values({ variantId, email, userId });
  return { alreadyOnList: false };
}

export async function countWaitlist(variantId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.variantId, variantId),
        sql`${waitlistEntries.notifiedAt} is null`,
      ),
    );
  return row.value;
}
