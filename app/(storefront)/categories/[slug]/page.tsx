import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiscoveryResults } from "@/components/discovery-results";
import type { CategoryFacetView } from "@/components/filter-panel";
import { PageHeading } from "@/components/page-heading";
import {
  collectSubtreeIds,
  discover,
  findCategoryPath,
  getCategoryBySlug,
  getCategoryTree,
  listingHref,
  subtreeCount,
} from "@/lib/catalog";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/categories/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) return { title: "Category not found" };

  // A category is a landing page; the same category filtered, sorted or on
  // page nine is not a second one. Those variants stay out of the index and
  // point at the plain shelf.
  const query = await searchParams;
  const varied = Object.keys(query).length > 0;

  return {
    title: category.name,
    description: `Preorder ${category.name.toLowerCase()} from the US, delivered in Bangladesh at a fixed landed price.`,
    alternates: { canonical: `/categories/${category.slug}` },
    ...(varied ? { robots: { index: false, follow: true } } : {}),
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

  // A category page is a listing with its shelf fixed. It takes no search
  // words — the search box goes to /search — so a stray `q` is ignored.
  const { q: _ignored, ...listingParams } = query;
  void _ignored;

  const result = await discover({ params: listingParams, categoryIds });

  const counts = result.facets.categoryCounts;
  const parent = path.length > 1 ? path.at(-2) : undefined;
  const categoryFacet: CategoryFacetView | null =
    node && node.children.length > 0
      ? {
          heading: "Subcategory",
          up: parent
            ? { label: `‹ ${parent.name}`, href: `/categories/${parent.slug}` }
            : null,
          items: node.children
            .map((child) => ({
              label: child.name,
              href: listingHref(`/categories/${child.slug}`, listingParams),
              count: subtreeCount(child, counts),
            }))
            .filter((item) => item.count > 0),
        }
      : null;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6 md:py-8">
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
              <span className="font-semibold tabular-nums text-ink">
                {result.total.toLocaleString("en-GB")}
              </span>{" "}
              listing{result.total === 1 ? "" : "s"} filed here and in everything
              beneath it. Every price already carries shipping and customs duty.
            </>
          }
        />
      </div>

      {node && node.children.length > 0 ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {node.children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/categories/${child.slug}`}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-blue-300 bg-paper px-3 text-meta font-medium text-blue-600 transition-[background-color,border-color,box-shadow] duration-150 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <DiscoveryResults
        result={result}
        path={`/categories/${category.slug}`}
        params={listingParams}
        categories={categoryFacet}
        emptyTitle="Nothing in this category yet"
        emptyBody="We are still sourcing for this section. Browse another category, or check back shortly."
      />
    </div>
  );
}
