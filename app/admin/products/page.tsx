import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { listProductsForAdmin } from "@/lib/catalog";
import { StatusBadge } from "@/components/status-badge";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

const statusTone = {
  preorder_open: "preorder",
  in_stock: "positive",
  preorder_closed: "negative",
  discontinued: "negative",
  archived: "negative",
} as const;

const statusLabel: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  in_stock: "In stock",
  preorder_open: "Preorder open",
  preorder_closed: "Preorder closed",
  coming_soon: "Coming soon",
  discontinued: "Discontinued",
  archived: "Archived",
};

export default async function AdminProductsPage() {
  const user = await getCurrentUser();
  const rows = await listProductsForAdmin(user, { includeArchived: true });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-meta text-blue-400">Catalog</p>
          <h1 className="mt-2 font-display text-h1 text-ink">Products</h1>
        </div>
        <Link
          href="/admin/products/new"
          className="inline-flex min-h-11 items-center rounded-control bg-brass px-4 text-body font-medium text-ink"
        >
          Add product
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="border border-blue-300 p-8 text-center">
          <p className="text-body text-ink">No products yet.</p>
          <p className="mt-2 text-meta text-ink/70">
            Add your first listing to start taking preorders.
          </p>
          <Link
            href="/admin/products/new"
            className="mt-4 inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Add product
          </Link>
        </div>
      ) : (
        /* The manifest table: bordered ledger, zebra rows, numbers right-aligned */
        <div className="overflow-x-auto border border-blue-300">
          <table className="w-full min-w-[640px] border-collapse text-body">
            <thead>
              <tr className="bg-paper text-left">
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Product
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Category
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right text-meta font-medium">
                  Variants
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.id}
                  className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                >
                  <td className="border-t border-blue-300 px-4 py-3">
                    <Link
                      href={`/admin/products/${row.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {row.title}
                    </Link>
                    {row.brand ? (
                      <span className="block text-meta text-ink/60">
                        {row.brand}
                      </span>
                    ) : null}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-ink/80">
                    {row.categoryName ?? "—"}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3">
                    <StatusBadge
                      tone={
                        statusTone[row.status as keyof typeof statusTone] ??
                        "neutral"
                      }
                    >
                      {statusLabel[row.status] ?? row.status}
                    </StatusBadge>
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                    {row.variantCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
