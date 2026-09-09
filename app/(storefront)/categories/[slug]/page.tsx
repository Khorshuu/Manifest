import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterPanel } from "@/components/filter-panel";
import { PageHeading } from "@/components/page-heading";
import { ProductGrid } from "@/components/product-grid";
import { SortSelect } from "@/components/sort-select";
import {
  collectSubtreeIds,
  countProducts,
  findCategoryPath,
  getCategoryBySlug,
  getCategoryTree,
  hasActiveFilters,
  listFacets,
  listProductCards,
  parseFilterParams,
  type ProductSort,
} from "@/lib/catalog";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export async function generateMetadata({
  params,
}: PageProps<"/categories/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) return { title: "Category not found" };

  return {
    title: category.name,
    description: `Preorder ${category.name.toLowerCase()} from the US, delivered in Bangladesh at a fixed landed price.`,
    alternates: { canonical: `/categories/${category.slug}` },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: PageProps<"/categories/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;

  const category = await getCategoryBySlug(slug);
  if (!category) notFound();

  const tree = await getCategoryTree();
  const path = findCategoryPath(tree, category.id);
  const node = path.at(-1);
  // A category page includes everything beneath it, not only direct children.
  const categoryIds = node ? collectSubtreeIds(node) : [category.id];

  const sort = (typeof query.sort === "string" ? query.sort : "relevance") as ProductSort;
  const page = Math.max(1, Number(query.page) || 1);

  // The same filters drive the listing, the count, and the facet counts, so
  // the number on the page always describes the page.
  const filters = { ...parseFilterParams(query), categoryIds };

  const [products, total, facets] = await Promise.all([
    listProductCards({
      ...filters,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countProducts(filters),
    listFacets(filters),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (target: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
        next.append(key, entry);
      }
    }
    next.set("sort", sort);
    next.set("page", String(target));
    return `?${next.toString()}`;
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-meta text-ink/70">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          {path.map((crumb) => (
            <li key={crumb.id} className="flex items-center gap-2">
              <span aria-hidden="true">/</span>
              <Link href={`/categories/${crumb.slug}`} className="hover:underline">
                {crumb.name}
              </Link>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-6">
        <PageHeading
          eyebrow="The shelf"
          title={category.name}
          summary={
            <>
              {total} listing{total === 1 ? "" : "s"} filed here and in
              everything beneath it. Every price already carries shipping and
              customs duty.
            </>
          }
          aside={<SortSelect current={sort} />}
        />
      </div>

      {node && node.children.length > 0 ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {node.children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/categories/${child.slug}`}
                className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-3 text-meta border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <FilterPanel
          facets={facets}
          action={`/categories/${category.slug}`}
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
                : "Nothing in this category yet"
            }
            emptyBody={
              hasActiveFilters(filters)
                ? "Widen the price range or clear a filter to see more."
                : "We are still sourcing for this section. Browse another category, or check back shortly."
            }
          />
        </div>
      </div>

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="mt-10 flex gap-3">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
            >
              Previous
            </Link>
          ) : null}
          <span className="inline-flex min-h-11 items-center text-meta text-ink/70">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={pageHref(page + 1)}
              className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
