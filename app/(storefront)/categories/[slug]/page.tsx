import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductGrid } from "@/components/product-grid";
import { SortSelect } from "@/components/sort-select";
import {
  collectSubtreeIds,
  countProducts,
  findCategoryPath,
  getCategoryBySlug,
  getCategoryTree,
  listProductCards,
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

  const [products, total] = await Promise.all([
    listProductCards({
      categoryIds,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countProducts({ categoryIds }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-h1 text-ink">{category.name}</h1>
          <p className="mt-2 text-meta text-ink/70">
            {total} product{total === 1 ? "" : "s"}
          </p>
        </div>
        <SortSelect current={sort} />
      </div>

      {node && node.children.length > 0 ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {node.children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/categories/${child.slug}`}
                className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-3 text-meta text-blue-600 hover:border-blue-500"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-8">
        <ProductGrid
          products={products}
          emptyTitle="Nothing in this category yet."
          emptyBody="We are still sourcing for this section. Browse another category, or check back shortly."
        />
      </div>

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="mt-10 flex gap-3">
          {page > 1 ? (
            <Link
              href={`?sort=${sort}&page=${page - 1}`}
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
            >
              Previous
            </Link>
          ) : null}
          <span className="inline-flex min-h-11 items-center text-meta text-ink/70">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={`?sort=${sort}&page=${page + 1}`}
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
