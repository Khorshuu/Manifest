import { cleanQuery, isStopword, queryTokens } from "@/lib/search/normalize";
import { correctSearch, planSearch, type SearchPlan } from "@/lib/search/plan";
import {
  listFacets,
  prepareFilters,
  sortSignals,
  type Facets,
  type PreparedFilters,
} from "./facets";
import { parseDiscoveryParams, type SearchParamsRecord } from "./filter-params";
import {
  countProducts,
  listProductCards,
  parseSort,
  type ProductCard,
  type ProductSort,
} from "./storefront";

/**
 * One listing, end to end: the search page and every category page ask for
 * results the same way, so they filter, sort, count and page the same way.
 * A category page is a search with its shelf fixed and no words.
 */

export const DISCOVERY_PAGE_SIZE = 24;

/**
 * Deep pages are for crawlers and scripts; people refine instead. Capping the
 * page keeps a request for page 90,000 from becoming an expensive offset.
 */
export const MAX_PAGE = 100;

export const SORT_LABELS: Record<ProductSort, string> = {
  relevance: "Relevance",
  featured: "Featured",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  rating: "Avg. customer rating",
  newest: "Newest arrivals",
  best_selling: "Best selling",
  discount: "Biggest discount",
};

export type SortOption = { value: ProductSort; label: string };

export type DiscoveryResult = {
  /** What the shopper typed, cleaned. Empty on a category page. */
  query: string;
  /** The search the results answer — the correction, when one was applied. */
  plan: SearchPlan | null;
  /** The search that found nothing, when the results are for a correction. */
  correctedFrom: string | null;
  /** A likely correction that was not applied, for "Did you mean". */
  suggestion: string | null;
  filters: PreparedFilters;
  sort: ProductSort;
  sorts: SortOption[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  products: ProductCard[];
  facets: Facets;
  /** Parts of a search that finds nothing whole, with what each finds alone. */
  related: { query: string; count: number }[];
};

function sortOptions(
  hasSearch: boolean,
  signals: { sales: boolean; ratings: boolean; discounts: boolean },
  current: ProductSort,
): SortOption[] {
  const offered: ProductSort[] = [
    ...(hasSearch ? (["relevance"] as const) : []),
    "featured",
    "price_asc",
    "price_desc",
    ...(signals.ratings ? (["rating"] as const) : []),
    "newest",
    ...(signals.sales ? (["best_selling"] as const) : []),
    ...(signals.discounts ? (["discount"] as const) : []),
  ];

  // A sort someone arrived with stays selectable, even if it has nothing to
  // sort by today — the select must not claim a different order than the page.
  if (!offered.includes(current)) offered.push(current);

  return offered.map((value) => ({ value, label: SORT_LABELS[value] }));
}

/**
 * For a search of several words that finds nothing: what each word finds on
 * its own. "purple studio headphones" may have no purple, but "headphones"
 * alone has three — which is more use than an empty page and invents nothing.
 */
async function relatedSearches(
  plan: SearchPlan,
  categoryIds: string[] | undefined,
): Promise<{ query: string; count: number }[]> {
  const typed = queryTokens(plan.query);
  const words = plan.words
    .map((word, index) => ({ word, label: typed[index] ?? word }))
    .filter(({ word }) => word.length >= 2 && !isStopword(word));

  if (words.length < 2) return [];

  const found = await Promise.all(
    words.slice(0, 4).map(async ({ label }) => {
      const single = await planSearch(label);
      if (!single) return null;
      const count = await countProducts({ plan: single, categoryIds });
      return count > 0 ? { query: label, count } : null;
    }),
  );

  return found.filter(
    (entry): entry is { query: string; count: number } => entry !== null,
  );
}

export async function discover({
  params,
  categoryIds,
  pageSize = DISCOVERY_PAGE_SIZE,
}: {
  params: SearchParamsRecord;
  /** A fixed scope — a category page's subtree, or the search page's category filter. */
  categoryIds?: string[];
  pageSize?: number;
}): Promise<DiscoveryResult> {
  const query = cleanQuery(params.q);
  const [fromUrl, plan] = await Promise.all([
    parseDiscoveryParams(params),
    planSearch(query),
  ]);

  // Legacy value ids are folded into named options here, once, rather than
  // being looked up again by every query below.
  let filters: PreparedFilters = {
    ...(await prepareFilters({ ...fromUrl, categoryIds, plan })),
    valueIds: [],
  };
  let total = await countProducts(filters);
  let activePlan = plan;
  let correctedFrom: string | null = null;
  let suggestion: string | null = null;

  /*
   * Typo tolerance, without autocorrecting anything that worked: a correction
   * is only tried when the search as typed found nothing, and only applied if
   * it finds something. Otherwise it is offered, not imposed.
   */
  // `spell=0` is "search instead for what I typed", from the correction notice.
  if (plan && total === 0 && params.spell !== "0") {
    const corrected = await correctSearch(plan);
    if (corrected) {
      const retry: PreparedFilters = { ...filters, plan: corrected };
      const retryTotal = await countProducts(retry);
      if (retryTotal > 0) {
        filters = retry;
        total = retryTotal;
        activePlan = corrected;
        correctedFrom = plan.query;
      } else {
        suggestion = corrected.query;
      }
    }
  }

  const requestedSort = parseSort(params.sort, activePlan ? "relevance" : "featured");
  const sort: ProductSort =
    requestedSort === "relevance" && !activePlan ? "featured" : requestedSort;

  const pageCount = Math.max(1, Math.min(MAX_PAGE, Math.ceil(total / pageSize)));
  const requested = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page =
    Number.isInteger(requested) && requested > 1 ? Math.min(requested, pageCount) : 1;

  const [productsOnPage, facets, signals, related] = await Promise.all([
    total === 0
      ? Promise.resolve([] as ProductCard[])
      : listProductCards({
          ...filters,
          sort,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
    listFacets(filters),
    sortSignals(),
    total === 0 && activePlan
      ? relatedSearches(activePlan, categoryIds)
      : Promise.resolve([]),
  ]);

  return {
    query,
    plan: activePlan,
    correctedFrom,
    suggestion,
    filters,
    sort,
    sorts: sortOptions(Boolean(activePlan), signals, sort),
    page,
    pageCount,
    pageSize,
    total,
    products: productsOnPage,
    facets,
    related,
  };
}
