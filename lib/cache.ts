import { revalidateTag } from "next/cache";

/**
 * Cache tags, and the one way catalogue writes invalidate them
 * (DECISIONS.md D-054).
 *
 * Cached reads tag themselves with these; every `lib/` function that changes
 * what a shopper can see calls `invalidateCatalog` next to its audit write, so
 * no route has to remember to. Only shared, customer-visible catalogue data is
 * cached. Sessions, carts, wishlists, live prices, capacity and anything else
 * per person or per moment is never cached.
 */
export const CACHE_TAGS = {
  /** The category tree and per-category product counts. */
  categories: "catalog:categories",
  /** Anything listing products: cards, shelves, search results, sitemap. */
  listing: "catalog:listing",
  /** One product's page. */
  product: (id: string) => `product:${id}`,
  /** Popular and trending searches. */
  searchInspiration: "search:inspiration",
  /** Homepage campaigns. */
  homepage: "homepage:campaigns",
} as const;

/**
 * Marks tagged cache entries stale so the next request reads fresh data.
 *
 * `expire: 0`: staff who publish or edit a product expect the storefront to
 * show it on their next look, not after a background refresh. Catalogue writes
 * are rare, so a blocking refresh after one costs little.
 *
 * Outside a Next.js request (tests, scripts, the job runner's CLI) there is no
 * cache to invalidate, and `revalidateTag` throws; that is not a failure of the
 * write that called it.
 */
export function invalidateCatalog(tags: string[]): void {
  for (const tag of new Set(tags)) {
    try {
      revalidateTag(tag, { expire: 0 });
    } catch {
      // No request context: nothing is cached here.
    }
  }
}
