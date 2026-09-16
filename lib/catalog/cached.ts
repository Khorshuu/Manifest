import { cacheLife, cacheTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache";
import { getCategoryTree } from "./categories";
import { discover } from "./discovery";
import { listRecommendations } from "./recommendations";
import { getPublicProductBySlug } from "./products";
import {
  countPublicProductsByCategory,
  getProductRating,
  listClosingSoon,
  listProductCards,
  listRelatedProducts,
  pickCategoryImages,
} from "./storefront";
import { getRatingBreakdown, listApprovedReviews } from "@/lib/reviews";
import type { SearchParamsRecord } from "./filter-params";

/**
 * Cached catalogue reads for the storefront (DECISIONS.md D-054).
 *
 * Each wrapper holds data that is the same for every shopper and changes when
 * staff change the catalogue; admin writes invalidate the tags through the
 * audit log (lib/audit). Lifetimes are short enough that figures derived from
 * shoppers' own activity — places left on a card, what sells — are never more
 * than a minute or two behind. What a shopper is about to pay or reserve is
 * never read from here: the product page's variants, the cart and checkout
 * read the database directly.
 *
 * Maps become plain records, because a cached value is serialised.
 *
 * Homepage campaigns are deliberately not here: staff switch a slide on and
 * look at the homepage straight away, and a request already computing when the
 * change lands could otherwise cache the old slides (lib/cache.ts). They are
 * one small row, read per request.
 */

export async function cachedCategoryTree() {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.categories);
  return getCategoryTree();
}

export async function cachedCategoryCounts(): Promise<Record<string, number>> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.categories, CACHE_TAGS.listing);
  return Object.fromEntries(await countPublicProductsByCategory());
}

export async function cachedHomeData() {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.listing, CACHE_TAGS.categories);

  const [closingSoon, newest, categoryImages] = await Promise.all([
    listClosingSoon(8),
    listProductCards({ sort: "newest", limit: 20 }),
    pickCategoryImages(),
  ]);

  return {
    closingSoon,
    newest,
    categoryImages: Object.fromEntries(categoryImages),
  };
}

/**
 * A stable key for a listing's parameters: the same filters in any order are
 * one cache entry. Values are kept as given; discovery validates and bounds
 * them (lib/catalog/filter-params.ts), so the key space is bounded too.
 */
export function discoveryKey(params: SearchParamsRecord): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export async function cachedDiscover(key: string, categoryIds: string[] | undefined) {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.listing, CACHE_TAGS.categories);
  const params = Object.fromEntries(JSON.parse(key) as [string, string | string[]][]);
  return discover({ params, categoryIds });
}

/**
 * Everything on a product page that is the same for everyone: the listing,
 * its reviews and rating, and the two recommendation rows. The variants —
 * live price, places left, whether the window is open — are not in here.
 */
export async function cachedProductContent(slug: string) {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.productPages, CACHE_TAGS.listing);

  const product = await getPublicProductBySlug(slug);
  if (!product) return null;
  cacheTag(CACHE_TAGS.product(product.id));

  const [suggested, sameShelf, rating, reviews, breakdown] = await Promise.all([
    listRecommendations(product.id, 4),
    listRelatedProducts(product.id, product.categoryId, 8),
    getProductRating(product.id),
    listApprovedReviews(product.id),
    getRatingBreakdown(product.id),
  ]);

  return { product, suggested, sameShelf, rating, reviews, breakdown };
}
