import type { Metadata } from "next";
import { LinkButton } from "@/components/button";
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  getCategoryTree,
  listProductsForAdmin,
  PUBLIC_STATUSES,
  type AdminProductRow,
  type CategoryNode,
} from "@/lib/catalog";
import {
  DEFAULT_FILTERS,
  SORTS,
  STATUS_FILTERS,
  STOCK_FILTERS,
  type Filters,
} from "./filters";
import { ProductTable, type Inventory } from "./product-table";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

/**
 * Out of stock: it has variants, and none can be bought — no units on hand,
 * no preorder places left, no uncapped preorder. Low: at least one variant is
 * at or below its low-stock line (see listProductsForAdmin).
 */
function inventoryOf(row: AdminProductRow): Inventory {
  if (row.variantCount === 0) return "none";
  const sellable =
    (row.stockOnHand ?? 0) > 0 || (row.preorderRemaining ?? 0) > 0 || row.uncappedPreorders > 0;
  if (!sellable) return "out";
  return row.lowStockVariants > 0 ? "low" : "in_stock";
}

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  const text = Array.isArray(value) ? value[0] : value;
  return (allowed as readonly string[]).includes(text ?? "") ? (text as T) : fallback;
}

/**
 * Admin → Products: what exists, what is live, what is a draft, what has run
 * out — and the next step for each, in plain sight.
 */
export default async function AdminProductsPage({ searchParams }: PageProps<"/admin/products">) {
  const user = await requireAdminPage("catalog.manage");
  const query = await searchParams;
  const [rows, tree] = await Promise.all([
    listProductsForAdmin(user, { includeArchived: true }),
    getCategoryTree(),
  ]);

  const initial: Filters = {
    q: typeof query.q === "string" ? query.q.slice(0, 100) : "",
    status: pick(query.status, STATUS_FILTERS, DEFAULT_FILTERS.status),
    stock: pick(query.stock, STOCK_FILTERS, DEFAULT_FILTERS.stock),
    category: typeof query.category === "string" ? query.category : "",
    sort: pick(query.sort, SORTS, DEFAULT_FILTERS.sort),
  };

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
        rows={rows.map((row) => {
          const archived = row.archivedAt !== null || row.status === "archived";
          return {
            id: row.id,
            title: row.title,
            slug: row.slug,
            brand: row.brand,
            sku: row.sku,
            status: archived ? "archived" : row.status,
            archived,
            live: !archived && (PUBLIC_STATUSES as readonly string[]).includes(row.status),
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
            inventory: inventoryOf(row),
            updatedAt: row.updatedAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
          };
        })}
      />
    </div>
  );
}
