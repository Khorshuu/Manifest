import type { Metadata } from "next";
import Link from "next/link";
import { ProductGrid } from "@/components/product-grid";
import { SortSelect } from "@/components/sort-select";
import {
  countProducts,
  getCategoryTree,
  listProductCards,
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

  const [products, total, tree] = await Promise.all([
    listProductCards({
      query: query || undefined,
      preorderOnly,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countProducts({ query: query || undefined }),
    getCategoryTree(),
  ]);

  const heading = preorderOnly
    ? "Open preorders"
    : query
      ? `Results for “${query}”`
      : "All products";

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-h1 text-ink">{heading}</h1>
          <p className="mt-2 text-meta text-ink/70">
            {products.length} shown{query ? ` · ${total} match in total` : ""}
          </p>
        </div>
        <SortSelect current={sort} />
      </div>

      <div className="mt-8">
        <ProductGrid
          products={products}
          emptyTitle={
            query ? `Nothing matched “${query}”.` : "Nothing listed yet."
          }
          emptyBody="Check the spelling, try a shorter search, or browse a category below."
        />
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
                  className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-3 text-meta text-blue-600 hover:border-blue-500"
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
