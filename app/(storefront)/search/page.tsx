import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { DiscoveryResults } from "@/components/discovery-results";
import type { CategoryFacetView } from "@/components/filter-panel";
import { NoResults } from "@/components/no-results";
import { PageHeading } from "@/components/page-heading";
import { getCurrentUser } from "@/lib/auth";
import {
  collectSubtreeIds,
  discover,
  findCategoryPathBySlug,
  getCategoryTree,
  hasActiveFilters,
  listingHref,
  subtreeCount,
  type CategoryNode,
} from "@/lib/catalog";
import { logSearch } from "@/lib/search/analytics";
import { recordSearchHistory } from "@/lib/search/history";
import { cleanQuery } from "@/lib/search/normalize";
import { currentVisitorHash, isPrefetchRequest } from "@/lib/search/visitor";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: PageProps<"/search">): Promise<Metadata> {
  const query = cleanQuery((await searchParams).q);

  return {
    title: query ? `Results for “${query}”` : "Search",
    // Search results are not landing pages: thousands of near-identical
    // filtered URLs would compete with the category and product pages that
    // are. Followed, so the products they link to are still found.
    robots: { index: false, follow: true },
  };
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export default async function SearchPage({
  searchParams,
}: PageProps<"/search">) {
  const params = await searchParams;
  const tree = await getCategoryTree();

  const categorySlug = typeof params.category === "string" ? params.category : "";
  const categoryPath = categorySlug ? findCategoryPathBySlug(tree, categorySlug) : [];
  const categoryNode = categoryPath.at(-1);

  const result = await discover({
    params,
    categoryIds: categoryNode ? collectSubtreeIds(categoryNode) : undefined,
  });

  const filtered = hasActiveFilters(result.filters) || Boolean(categoryNode);

  /*
   * Counting the search, after the page has gone. Only the first page of an
   * unfiltered search counts as a search — paging, sorting and filtering are
   * the same search continued — and a prefetch is not a search at all. The
   * request is read now, because it cannot be read once rendering is over.
   */
  if (result.query && result.page === 1) {
    const [prefetch, visitorHash, user] = await Promise.all([
      isPrefetchRequest(),
      currentVisitorHash(),
      getCurrentUser(),
    ]);

    if (!prefetch) {
      if (!filtered) {
        const query = result.query;
        // A search rescued by a correction still found nothing as typed,
        // which is what the zero-results report needs to see.
        const resultsCount = result.correctedFrom ? 0 : result.total;
        const correctedQuery = result.correctedFrom ? (result.plan?.query ?? null) : null;
        after(() =>
          logSearch({ query, resultsCount, correctedQuery, visitorHash }),
        );
      }
      if (user) {
        const query = result.query;
        after(() => recordSearchHistory(user, query));
      }
    }
  }

  const counts = result.facets.categoryCounts;
  const parent = categoryPath.length > 1 ? categoryPath.at(-2) : undefined;
  const categoryFacet: CategoryFacetView = categoryNode
    ? {
        heading: "Category",
        up: {
          label: parent ? `‹ ${parent.name}` : "‹ Any category",
          href: listingHref("/search", params, {
            category: parent ? parent.slug : null,
          }),
        },
        current: categoryNode.name,
        items: categoryNode.children
          .map((child) => ({
            label: child.name,
            href: listingHref("/search", params, { category: child.slug }),
            count: subtreeCount(child, counts),
          }))
          .filter((item) => item.count > 0),
      }
    : {
        heading: "Category",
        items: tree
          .map((node) => ({
            label: node.name,
            href: listingHref("/search", params, { category: node.slug }),
            count: subtreeCount(node, counts),
          }))
          .filter((item) => item.count > 0),
      };

  const preorderOnly = !result.query && result.filters.fulfillment === "preorder";
  const shownQuery = result.plan?.query ?? result.query;

  const heading = result.query
    ? `Results for “${shownQuery}”`
    : categoryNode
      ? categoryNode.name
      : preorderOnly
        ? "Open preorders"
        : "All products";

  const hidden: Record<string, string> = {};
  if (result.query) hidden.q = result.query;
  if (categoryNode) hidden.category = categoryNode.slug;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6 md:py-8">
      <PageHeading
        eyebrow={
          result.query
            ? "Search"
            : preorderOnly
              ? "Windows open now"
              : categoryNode
                ? "The shelf"
                : "The catalogue"
        }
        title={heading}
        summary={
          <>
            <span className="font-semibold tabular-nums text-ink">
              {result.total.toLocaleString("en-GB")}
            </span>{" "}
            {result.total === 1 ? "result" : "results"}
            {categoryNode && result.query ? ` in ${categoryNode.name}` : ""}.
            Every price already carries shipping and customs duty.
          </>
        }
      />

      {result.correctedFrom ? (
        <div
          role="status"
          className="mt-4 rounded-card border border-brass/60 bg-brass/10 px-4 py-3 text-body text-ink"
        >
          <p>
            No results for “{result.correctedFrom}”. Showing results for{" "}
            <strong className="font-semibold">“{shownQuery}”</strong> instead.
          </p>
          <p className="mt-1 text-meta">
            <Link
              href={`/search?q=${encodeURIComponent(result.correctedFrom)}&spell=0`}
              className="font-semibold text-blue-600 underline underline-offset-4"
            >
              Search instead for “{result.correctedFrom}”
            </Link>
          </p>
        </div>
      ) : null}

      {result.suggestion && result.total > 0 ? (
        <p className="mt-4 text-body text-ink">
          Did you mean{" "}
          <Link
            href={`/search?q=${encodeURIComponent(result.suggestion)}`}
            className="font-semibold text-blue-600 underline underline-offset-4"
          >
            {result.suggestion}
          </Link>
          ?
        </p>
      ) : null}

      <DiscoveryResults
        result={result}
        path="/search"
        params={params}
        hidden={hidden}
        categories={categoryFacet}
        categoryNames={new Map(flatten(tree).map((node) => [node.slug, node.name]))}
        noResults={
          result.query ? (
            <NoResults
              query={result.query}
              suggestion={result.suggestion}
              related={result.related}
              filtered={filtered}
              clearHref={`/search?q=${encodeURIComponent(result.query)}`}
            />
          ) : undefined
        }
        emptyTitle="Nothing listed yet"
        emptyBody="Browse a category below, or check back shortly."
      />

      {/* Never a bare empty page: always offer somewhere to go next. */}
      {result.total === 0 && tree.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-h3 text-ink">Browse categories</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {tree.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-blue-300 bg-paper px-3 text-meta font-medium text-blue-600 transition-[background-color,border-color,box-shadow] duration-150 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
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
