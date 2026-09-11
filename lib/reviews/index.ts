import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orderItems,
  orders,
  productVariants,
  products,
  reviews,
  users,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Reviews.
 *
 * Two rules carry the weight. Only someone who actually received the product
 * may review it, proved by a delivered order item rather than by a flag anyone
 * can set. And no review is public until a human approves it, so the average
 * shown on a product page cannot be moved by a stranger
 * (docs/BUSINESS_LOGIC.md).
 */

export class ReviewError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export type ReviewInput = {
  productId: string;
  rating: number;
  title?: string | null;
  body?: string | null;
};

/**
 * The order item that entitles this person to review this product, or null.
 * Delivered only: a preorder still in customs has not been seen by anyone.
 */
export async function findEligibleOrderItem(
  userId: string,
  productId: string,
): Promise<{ orderItemId: string } | null> {
  const [row] = await db
    .select({ orderItemId: orderItems.id })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.status, "delivered"),
        eq(productVariants.productId, productId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function submitReview(
  actor: SessionUser | null,
  input: ReviewInput,
) {
  if (!actor) throw new ReviewError("Sign in to write a review.");

  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ReviewError("Choose a rating from 1 to 5.");
  }

  // Verified purchase, checked here rather than trusted from the client.
  const eligible = await findEligibleOrderItem(actor.id, input.productId);

  if (!eligible) {
    throw new ReviewError(
      "Only someone who has received this product can review it.",
    );
  }

  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(eq(reviews.userId, actor.id), eq(reviews.productId, input.productId)),
    )
    .limit(1);

  if (existing) {
    throw new ReviewError("You have already reviewed this product.");
  }

  const [created] = await db
    .insert(reviews)
    .values({
      productId: input.productId,
      userId: actor.id,
      orderItemId: eligible.orderItemId,
      rating: input.rating,
      title: input.title?.trim() || null,
      body: input.body?.trim() || null,
      // Pending until a human looks at it. Nothing reaches the public average
      // on the strength of having been typed.
      status: "pending",
    })
    .returning();

  return created;
}

/** Whether this person has already reviewed this product, in any status. */
export async function hasReviewed(
  userId: string,
  productId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.productId, productId)))
    .limit(1);

  return Boolean(row);
}

export type PublicReview = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  authorName: string;
  createdAt: Date;
};

/**
 * Approved reviews for the product page. The author is shown as a first name
 * and an initial, never as an email address.
 */
export async function listApprovedReviews(
  productId: string,
  limit = 20,
): Promise<PublicReview[]> {
  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      email: users.email,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(and(eq(reviews.productId, productId), eq(reviews.status, "approved")))
    .orderBy(desc(reviews.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorName: displayName(row.email),
    createdAt: row.createdAt,
  }));
}

/** "hasnain@example.com" becomes "Hasnain". Never the domain, never the whole address. */
function displayName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[._-]/)[0] ?? local;
  if (!first) return "A customer";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** How the ratings are spread, for the histogram on the product page. */
export async function getRatingBreakdown(
  productId: string,
): Promise<Record<1 | 2 | 3 | 4 | 5, number>> {
  const rows = await db
    .select({
      rating: reviews.rating,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(and(eq(reviews.productId, productId), eq(reviews.status, "approved")))
    .groupBy(reviews.rating);

  const breakdown: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  for (const row of rows) {
    const key = row.rating as 1 | 2 | 3 | 4 | 5;
    if (key >= 1 && key <= 5) breakdown[key] = row.count;
  }

  return breakdown;
}

export type ModerationRow = {
  id: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  authorEmail: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: string;
  createdAt: Date;
};

/** The moderation queue. Staff only: it carries the reviewer's email. */
export async function listReviewsForModeration(
  actor: SessionUser | null,
  options: { status?: string; limit?: number } = {},
): Promise<ModerationRow[]> {
  requirePermission(actor, "reviews.moderate");

  return db
    .select({
      id: reviews.id,
      productId: reviews.productId,
      productTitle: products.title,
      productSlug: products.slug,
      authorEmail: users.email,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      status: reviews.status,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(products, eq(products.id, reviews.productId))
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(options.status ? eq(reviews.status, options.status) : undefined)
    .orderBy(desc(reviews.createdAt))
    .limit(options.limit ?? 100);
}

export async function countPendingReviews(
  actor: SessionUser | null,
): Promise<number> {
  requirePermission(actor, "reviews.moderate");

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviews)
    .where(eq(reviews.status, "pending"));

  return row?.value ?? 0;
}

/**
 * Approve or reject. Both are recorded in the audit log with the previous
 * status, so a review that disappears from a product page can be explained.
 */
export async function moderateReview(
  actor: SessionUser | null,
  reviewId: string,
  decision: "approved" | "rejected",
) {
  const staff = requirePermission(actor, "reviews.moderate");

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: reviews.id, status: reviews.status })
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    if (!before) throw new ReviewError("That review no longer exists.");

    const [updated] = await tx
      .update(reviews)
      .set({ status: decision, updatedAt: new Date() })
      .where(eq(reviews.id, reviewId))
      .returning({ id: reviews.id, status: reviews.status });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "review.moderated",
        entityType: "review",
        entityId: reviewId,
        before: { status: before.status },
        after: { status: decision },
      },
      tx,
    );

    return updated;
  });
}

export type ReviewableProduct = {
  productId: string;
  title: string;
  slug: string;
};

/**
 * Delivered products this person has not reviewed yet, for their account page.
 * Asking someone to review something they never received is the fastest way to
 * make the reviews worthless.
 */
export async function listReviewableProducts(
  actor: SessionUser | null,
): Promise<ReviewableProduct[]> {
  if (!actor) return [];

  const delivered = await db
    .selectDistinct({
      productId: products.id,
      title: products.title,
      slug: products.slug,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(orders.userId, actor.id),
        eq(orders.status, "delivered"),
        isNull(products.archivedAt),
      ),
    );

  if (delivered.length === 0) return [];

  const already = await db
    .select({ productId: reviews.productId })
    .from(reviews)
    .where(
      and(
        eq(reviews.userId, actor.id),
        inArray(
          reviews.productId,
          delivered.map((row) => row.productId),
        ),
      ),
    );

  const reviewed = new Set(already.map((row) => row.productId));

  return delivered.filter((row) => !reviewed.has(row.productId));
}
