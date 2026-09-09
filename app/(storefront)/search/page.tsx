import type { Metadata } from "next";
import Link from "next/link";
import { FilterPanel } from "@/components/filter-panel";
import { PageHeading } from "@/components/page-heading";
import { ProductGrid } from "@/components/product-grid";
import { SortSelect } from "@/components/sort-select";
import {
  countProducts,
  getCategoryTree,
  hasActiveFilters,
  listFacets,
  listProductCards,
  parseFilterParams,
  type ProductSort,
} from "@/lib/catalog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  // Search result pages should not compete with category pages in an index.
  robots: { index: false },
};

const PAGE_SIZE = 24;

export default async function SearchPage({
  searchParams,
}: PageProps<"/search">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const preorderOnly = params.preorder === "1";
  const sort = (typeof params.sort === "string" ? params.sort : "relevance") as ProductSort;
  const page = Math.max(1, Number(params.page) || 1);

  const filters = { ...parseFilterParams(params), query: query || undefined };

  const [products, total, facets, tree] = await Promise.all([
    listProductCards({
      ...filters,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countProducts(filters),
    listFacets(filters),
    getCategoryTree(),
  ]);

  const heading = preorderOnly
    ? "Open preorders"
    : query
      ? `Results for “${query}”`
      : "All products";

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <PageHeading
        eyebrow={
          preorderOnly ? "Windows open now" : query ? "Search" : "The catalogue"
        }
        title={heading}
        summary={
          <>
            {products.length} shown
            {query && total !== products.length
              ? ` of ${total} that match`
              : ""}
            . Every price already carries shipping and customs duty.
          </>
        }
        aside={<SortSelect current={sort} />}
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <FilterPanel
          facets={facets}
          action="/search"
          hidden={query ? { q: query } : {}}
          total={total}
          hasFilters={hasActiveFilters(filters)}
          selected={{
            minTaka:
              filters.minPriceBdt === undefined
                ? ""
                : String(filters.minPriceBdt / 100),
            maxTaka:
              filters.maxPriceBdt === undefined
                ? ""
                : String(filters.maxPriceBdt / 100),
            fulfillment: filters.fulfillment ?? "",
            availableOnly: Boolean(filters.availableOnly),
            sort,
          }}
        />

        <div className="min-w-0">
          <ProductGrid
            products={products}
            emptyTitle={
              hasActiveFilters(filters)
                ? "Nothing matches those filters"
                : query
                  ? `Nothing matched “${query}”`
                  : "Nothing listed yet"
            }
            emptyBody={
              hasActiveFilters(filters)
                ? "Widen the price range or clear a filter to see more."
                : "Check the spelling, try a shorter search, or browse a category below."
            }
          />
        </div>
      </div>

      {/* Never a bare empty page: always offer somewhere to go next. */}
      {products.length === 0 && tree.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-h3 text-ink">Browse categories</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {tree.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-3 text-meta border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
                >
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
