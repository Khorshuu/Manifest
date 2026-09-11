import type { ReactNode } from "react";
import { ActiveFilters } from "./active-filters";
import { EmptyState } from "./empty-state";
import { FilterPanel, type CategoryFacetView } from "./filter-panel";
import { IconChevronDown } from "./icons";
import { Pagination } from "./pagination";
import { ProductGrid } from "./product-grid";
import { SearchResultTracker } from "./search-result-tracker";
import { SortSelect } from "./sort-select";
import type { DiscoveryResult } from "@/lib/catalog/discovery";
import {
  activeFilterChips,
  hasActiveFilters,
  listingHref,
  type OptionChipLabels,
  type SearchParamsRecord,
} from "@/lib/catalog/filter-params";

/**
 * Everything under a listing's heading, shared by the search page and every
 * category page so the two filter, sort, page and empty the same way: the
 * toolbar (Filter and Sort side by side on a phone), the chips of what is on,
 * the panel, the grid, and the pages.
 */
export function DiscoveryResults({
  result,
  path,
  params,
  hidden = {},
  categories,
  categoryNames,
  noResults,
  emptyTitle,
  emptyBody,
}: {
  result: DiscoveryResult;
  /** The listing these results belong to — "/search", "/categories/audio". */
  path: string;
  params: SearchParamsRecord;
  /** Carried by the filter form: the search, the sort, a category scope. */
  hidden?: Record<string, string>;
  categories?: CategoryFacetView | null;
  /** Category slug to name, for the search page's category chip. */
  categoryNames?: Map<string, string>;
  /** What to show when a search itself found nothing. */
  noResults?: ReactNode;
  /** What to show when a listing is empty with no filters on. */
  emptyTitle: string;
  emptyBody: string;
}) {
  const options: OptionChipLabels = new Map(
    result.facets.attributes.map((facet) => [
      facet.key,
      {
        name: facet.name,
        labels: new Map(
          facet.values.map((value) => [value.id.toLowerCase(), value.label]),
        ),
        // "Yes" on its own says nothing; "5G: Yes" does.
        showName: facet.values.every(
          (value) => value.label === "Yes" || value.label === "No",
        ),
      },
    ]),
  );

  const chips = activeFilterChips({
    params,
    path,
    options,
    categories: categoryNames,
  });

  // Clearing filters keeps the search and the sort — someone clearing a brand
  // did not ask to be sent back to the whole catalogue.
  const kept: SearchParamsRecord = {};
  if (params.q) kept.q = params.q;
  if (params.sort) kept.sort = params.sort;
  const clearHref = listingHref(path, kept);

  const filtered = chips.length > 0 || hasActiveFilters(result.filters);

  const positions = Object.fromEntries(
    result.products.map((product, index) => [
      product.slug,
      {
        id: product.id,
        position: (result.page - 1) * result.pageSize + index + 1,
      },
    ]),
  );

  const grid = <ProductGrid products={result.products} emptyTitle={emptyTitle} emptyBody={emptyBody} />;

  let body: ReactNode;
  if (result.total === 0 && filtered) {
    body = (
      <EmptyState
        title="Nothing matches those filters"
        body="Widen the price range or clear a filter to see more."
        action={{ href: clearHref, label: "Clear filters" }}
      />
    );
  } else if (result.total === 0 && noResults) {
    body = noResults;
  } else {
    body = (
      <>
        {result.plan ? (
          <SearchResultTracker query={result.plan.query} products={positions}>
            {grid}
          </SearchResultTracker>
        ) : (
          grid
        )}
        <Pagination
          page={result.page}
          pageCount={result.pageCount}
          hrefFor={(page) =>
            listingHref(path, params, { page: page > 1 ? String(page) : null })
          }
        />
      </>
    );
  }

  const selected = {
    minTaka:
      result.filters.minPriceBdt === undefined
        ? ""
        : String(result.filters.minPriceBdt / 100),
    maxTaka:
      result.filters.maxPriceBdt === undefined
        ? ""
        : String(result.filters.maxPriceBdt / 100),
    fulfillment: result.filters.fulfillment ?? "",
    availableOnly: Boolean(result.filters.availableOnly),
    minRating: result.filters.minRating ?? null,
    onSale: Boolean(result.filters.onSale),
  };

  return (
    <>
      <div className="mt-4 flex items-center gap-3 border-y border-blue-300/70 py-2.5 lg:border-0 lg:py-0">
        {/* Opens the sheet on a phone; the panel is always in view above lg. */}
        <label
          htmlFor="filter-drawer"
          className="inline-flex min-h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-control border border-blue-300 bg-paper px-4 text-meta font-semibold text-ink shadow-[var(--shadow-raise)] transition-colors hover:border-blue-500 sm:flex-none lg:hidden"
        >
          Filters
          {chips.length > 0 ? (
            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-ink px-1.5 text-meta font-bold tabular-nums text-paper">
              {chips.length}
            </span>
          ) : null}
          <IconChevronDown size={16} className="text-blue-500" />
        </label>

        <p className="hidden text-meta text-ink/70 lg:block">
          <span className="font-semibold tabular-nums text-ink">
            {result.total.toLocaleString("en-GB")}
          </span>{" "}
          {result.total === 1 ? "result" : "results"}
          {result.pageCount > 1
            ? ` · page ${result.page} of ${result.pageCount}`
            : ""}
        </p>

        <div className="flex flex-1 justify-end sm:flex-none lg:ml-auto">
          <SortSelect current={result.sort} options={result.sorts} />
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="mt-4">
          <ActiveFilters chips={chips} clearHref={clearHref} total={result.total} />
        </div>
      ) : null}

      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
        <FilterPanel
          facets={result.facets}
          action={path}
          params={params}
          hidden={{ ...hidden, sort: result.sort }}
          total={result.total}
          hasFilters={filtered}
          clearHref={clearHref}
          categories={categories}
          selected={selected}
        />

        <div className="min-w-0">{body}</div>
      </div>
    </>
  );
}
