import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { productVariants, waitlistEntries } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Opening, closing, and extending a preorder window.
 *
 * Closing is deliberate and reversible: a window that closed on its date can
 * be extended, and the reserved count is never touched by any of it — those
 * slots are sold.
 */

export class PreorderWindowError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "PreorderWindowError";
  }
}

export async function openPreorder(
  actor: SessionUser | null,
  variantId: string,
  options: { capacity: number | null; closesAt: Date | null },
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

    if (!before) throw new PreorderWindowError("That variant no longer exists.");

    if (options.capacity !== null && options.capacity < before.preorderReserved) {
      throw new PreorderWindowError(
        `Capacity cannot be below the ${before.preorderReserved} slot${
          before.preorderReserved === 1 ? "" : "s"
        } already reserved.`,
      );
    }

    if (options.closesAt && options.closesAt.getTime() <= Date.now()) {
      throw new PreorderWindowError("The closing date must be in the future.");
    }

    const [updated] = await tx
      .update(productVariants)
      .set({
        fulfillmentMode: "preorder",
        preorderCapacity: options.capacity,
        preorderClosesAt: options.closesAt,
        isEnabled: true,
        updatedAt: new Date(),
      })
      .where(eq(productVariants.id, variantId))
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.capacity_changed",
        entityType: "variant",
        entityId: variantId,
        before: {
          preorderCapacity: before.preorderCapacity,
          preorderClosesAt: before.preorderClosesAt,
        },
        after: {
          preorderCapacity: updated.preorderCapacity,
          preorderClosesAt: updated.preorderClosesAt,
        },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Closes the window now. Reserved slots stay reserved — they are orders that
 * still have to be fulfilled.
 */
export async function closePreorder(
  actor: SessionUser | null,
  variantId: string,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const now = new Date();

    const [updated] = await tx
      .update(productVariants)
      .set({ preorderClosesAt: now, updatedAt: now })
      .where(eq(productVariants.id, variantId))
      .returning();

    if (!updated) throw new PreorderWindowError("That variant no longer exists.");

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.capacity_changed",
        entityType: "variant",
        entityId: variantId,
        after: { closedAt: now },
      },
      tx,
    );

    return updated;
  });
}

/** Pushes the closing date out. Refuses a date in the past. */
export async function extendPreorder(
  actor: SessionUser | null,
  variantId: string,
  closesAt: Date,
) {
  const staff = requireStaff(actor);

  if (closesAt.getTime() <= Date.now()) {
    throw new PreorderWindowError("The new closing date must be in the future.");
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ closesAt: productVariants.preorderClosesAt })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

    if (!before) throw new PreorderWindowError("That variant no longer exists.");

    const [updated] = await tx
      .update(productVariants)
      .set({ preorderClosesAt: closesAt, updatedAt: new Date() })
      .where(eq(productVariants.id, variantId))
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "variant.capacity_changed",
        entityType: "variant",
        entityId: variantId,
        before: { preorderClosesAt: before.closesAt },
        after: { preorderClosesAt: closesAt },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Variants at or above a share of their capacity — the low-capacity alert on
 * the admin dashboard.
 */
export async function listNearCapacity(
  actor: SessionUser | null,
  threshold = 0.8,
) {
  requireStaff(actor);

  return db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      capacity: productVariants.preorderCapacity,
      reserved: productVariants.preorderReserved,
    })
    .from(productVariants)
    .where(
      sql`${productVariants.preorderCapacity} is not null
          and ${productVariants.archivedAt} is null
          and ${productVariants.preorderReserved} >= ${productVariants.preorderCapacity} * cast(${threshold} as numeric)`,
    );
}

/** Waitlist entries still waiting to hear about a variant. */
export async function listWaitlist(actor: SessionUser | null, variantId: string) {
  requireStaff(actor);

  return db
    .select({
      id: waitlistEntries.id,
      email: waitlistEntries.email,
      createdAt: waitlistEntries.createdAt,
    })
    .from(waitlistEntries)
    .where(
      sql`${waitlistEntries.variantId} = ${variantId}
          and ${waitlistEntries.notifiedAt} is null`,
    )
    .orderBy(waitlistEntries.createdAt);
}

/**
 * How many people are waiting on each variant of one product.
 *
 * One query for the whole product rather than `countWaitlist` per variant: the
 * windows screen shows every variant at once, and a product with a large
 * matrix would otherwise issue a query per row.
 */
export async function countWaitlistByProduct(
  actor: SessionUser | null,
  productId: string,
): Promise<Map<string, number>> {
  requireStaff(actor);

  const rows = await db
    .select({
      variantId: waitlistEntries.variantId,
      waiting: sql<number>`count(*)::int`,
    })
    .from(waitlistEntries)
    .innerJoin(
      productVariants,
      eq(productVariants.id, waitlistEntries.variantId),
    )
    .where(
      sql`${productVariants.productId} = ${productId}
          and ${waitlistEntries.notifiedAt} is null`,
    )
    .groupBy(waitlistEntries.variantId);

  return new Map(rows.map((row) => [row.variantId, Number(row.waiting)]));
}
