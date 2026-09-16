import type { Metadata } from "next";
import { LinkButton } from "@/components/button";
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  getCategoryTree,
  searchProductsForAdmin,
  type CategoryNode,
} from "@/lib/catalog";
import {
  DEFAULT_FILTERS,
  SORTS,
  STATUS_FILTERS,
  STOCK_FILTERS,
  type Filters,
} from "./filters";
import { ProductTable } from "./product-table";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Products" };

/** Products per page. */
const PAGE_SIZE = 50;

function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  const text = Array.isArray(value) ? value[0] : value;
  return (allowed as readonly string[]).includes(text ?? "") ? (text as T) : fallback;
}

/**
 * Admin → Products: what exists, what is live, what is a draft, what has run
 * out — and the next step for each, in plain sight. Filtered, sorted and paged
 * on the server (lib/catalog/products.ts), with the view in the address.
 */
export default async function AdminProductsPage({ searchParams }: PageProps<"/admin/products">) {
  const user = await requireAdminPage("catalog.manage");
  const query = await searchParams;

  const initial: Filters = {
    q: typeof query.q === "string" ? query.q.slice(0, 100) : "",
    status: pick(query.status, STATUS_FILTERS, DEFAULT_FILTERS.status),
    stock: pick(query.stock, STOCK_FILTERS, DEFAULT_FILTERS.stock),
    category: typeof query.category === "string" ? query.category : "",
    sort: pick(query.sort, SORTS, DEFAULT_FILTERS.sort),
  };
  const requestedPage = Number(Array.isArray(query.page) ? query.page[0] : query.page) || 1;

  const [result, tree] = await Promise.all([
    searchProductsForAdmin(user, {
      q: initial.q,
      status: initial.status,
      stock: initial.stock,
      categoryId: initial.category || undefined,
      sort: initial.sort,
      page: requestedPage,
      pageSize: PAGE_SIZE,
    }),
    getCategoryTree(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">Products</h1>
          <p className="mt-0.5 text-meta text-ink/65">
            Manage your catalogue, inventory, pricing and what customers can see.
          </p>
        </div>
        <LinkButton href="/admin/products/new" variant="primary">
          <span aria-hidden="true">+</span> Add product
        </LinkButton>
      </div>

      <ProductTable
        initial={initial}
        categories={flatten(tree)}
        counts={result.counts}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        rows={result.rows.map((row) => ({
          id: row.id,
          title: row.title,
          slug: row.slug,
          brand: row.brand,
          sku: row.sku,
          status: row.archived ? "archived" : row.status,
          archived: row.archived,
          live: row.live,
          searchable: row.searchable,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          variantCount: row.variantCount,
          imageUrl: row.imageUrl,
          minPriceBdt: row.minPriceBdt,
          maxPriceBdt: row.maxPriceBdt,
          stockOnHand: row.stockOnHand,
          preorderRemaining: row.preorderRemaining,
          uncappedPreorders: row.uncappedPreorders,
          inventory: row.inventory,
          updatedAt: row.updatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
