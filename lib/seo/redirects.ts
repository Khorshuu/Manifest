import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { productSlugRedirects, products } from "@/db/schema";
import type { Executor } from "@/lib/pkb/common";

/**
 * Old addresses keep working (D-078, finding F5).
 *
 * Renaming a listing used to change its URL with nothing left behind: every
 * link a shopper had saved, every search result already indexed and every
 * message with the address in it went to a 404. Two rules fix that.
 *
 *  1. A listing that has been public keeps its address when its title changes.
 *     The slug is only rebuilt from the title while the listing is a draft;
 *     after that it changes only when a person sets it.
 *  2. When the address does change, the old one is recorded here and answers
 *     with a permanent redirect to the current one.
 *
 * A slug that comes back into use — the same address on the same product, or a
 * new product taking a freed address — removes the redirect, so the table can
 * never point a live address somewhere else.
 */

/** Records the address a listing is leaving, unless it is another listing's live address. */
export async function recordSlugChange(
  executor: Executor,
  productId: string,
  fromSlug: string,
  toSlug: string,
  actorId: string | null,
): Promise<boolean> {
  const from = fromSlug.trim();
  const to = toSlug.trim();
  if (!from || from === to) return false;

  // A redirect must never shadow a live listing.
  const [live] = await executor
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.slug, from), ne(products.id, productId)));
  if (live) return false;

  await executor
    .insert(productSlugRedirects)
    .values({ fromSlug: from, productId, actorUserId: actorId })
    .onConflictDoUpdate({
      target: productSlugRedirects.fromSlug,
      set: { productId, actorUserId: actorId, createdAt: new Date() },
    });

  // The address being moved to is now live, so any redirect from it is stale.
  await executor.delete(productSlugRedirects).where(eq(productSlugRedirects.fromSlug, to));
  return true;
}

/** The listing an old address belongs to, and its current slug. */
export async function resolveSlugRedirect(
  slug: string,
  executor: Executor = db,
): Promise<{ productId: string; slug: string } | null> {
  const [row] = await executor
    .select({ productId: productSlugRedirects.productId, slug: products.slug })
    .from(productSlugRedirects)
    .innerJoin(products, eq(products.id, productSlugRedirects.productId))
    .where(eq(productSlugRedirects.fromSlug, slug));
  if (!row || row.slug === slug) return null;
  return row;
}

/** Every address one listing has had, newest first. */
export async function slugHistory(executor: Executor, productId: string) {
  return executor
    .select()
    .from(productSlugRedirects)
    .where(eq(productSlugRedirects.productId, productId))
    .orderBy(productSlugRedirects.createdAt);
}

/**
 * Whether a title change may rebuild the address. A draft has no audience yet;
 * anything that has been published, or is scheduled to be, keeps its address.
 */
export function slugMayFollowTitle(listing: { status: string; firstPublishedAt: Date | null }): boolean {
  return listing.firstPublishedAt === null && listing.status === "draft";
}
