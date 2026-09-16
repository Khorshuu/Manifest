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
  /** Every product page — for changes that touch many (settings, variants). */
  productPages: "catalog:product-pages",
  /** Popular and trending searches. */
  searchInspiration: "search:inspiration",
  /** Homepage campaigns. */
  homepage: "homepage:campaigns",
} as const;

/**
 * What an audited admin change invalidates, by the entity it names. Every
 * admin mutation writes the audit log, so invalidating here means no route or
 * function can forget to. Orders and accounts change nothing shared.
 */
export function invalidateForAudit(entityType: string): void {
  switch (entityType) {
    case "category":
      invalidateCatalog([CACHE_TAGS.categories, CACHE_TAGS.listing, CACHE_TAGS.productPages, CACHE_TAGS.homepage]);
      return;
    case "product":
    case "attribute":
    case "variant":
    case "review":
    case "search_synonym":
    case "search_index":
      invalidateCatalog([CACHE_TAGS.listing, CACHE_TAGS.productPages, CACHE_TAGS.homepage, CACHE_TAGS.categories, CACHE_TAGS.searchInspiration]);
      return;
    case "site_setting":
      // Homepage campaigns and the landed-price rates shown on product pages.
      invalidateCatalog([CACHE_TAGS.homepage, CACHE_TAGS.productPages, CACHE_TAGS.listing]);
      return;
    default:
      return;
  }
}

/**
 * Marks tagged cache entries stale so the next request reads fresh data.
 *
 * `expire: 0`: staff who publish or edit a product expect the storefront to
 * show it on their next look, not after a background refresh. Catalogue writes
 * are rare, so a blocking refresh after one costs little.
 *
 * One race remains and is accepted: a storefront request already computing an
 * entry from pre-commit rows when the invalidation lands can store its result
 * afterwards. That entry is then behind until its lifetime lapses (about a
 * minute for listings). Anything staff must see at once after saving — the
 * homepage campaigns — is not cached for that reason, and nothing a shopper
 * pays or reserves against is ever cached.
 *
 * Outside a Next.js request (tests, scripts, the job runner's CLI) there is no
 * cache to invalidate, and `revalidateTag` throws; that is not a failure of the
 * write that called it.
 */
export function invalidateCatalog(tags: string[]): void {
  const unique = [...new Set(tags)];
  const expire = () => {
    for (const tag of unique) {
      try {
        revalidateTag(tag, { expire: 0 });
      } catch {
        // No request context: nothing is cached here.
      }
    }
  };

  expire();
}
