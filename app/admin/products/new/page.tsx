import type { Metadata } from "next";
import { IconArrowLeft } from "@/components/icons";
import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { getCategoryTree, type CategoryNode } from "@/lib/catalog";
import { getProductResearchProvider } from "@/lib/providers/research";
import { ProductForm } from "./product-form";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Add product" };

/** Flattens the tree into indented options, so nesting is visible in a select. */
function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

export default async function NewProductPage() {
  await requireAdminPage("catalog.manage");
  const tree = await getCategoryTree();
  const categories = flatten(tree);
  /*
   * Whether automatic source discovery is set up at all — not which service
   * does it. Staff care about the first; the second is an administrator's
   * concern and stays on the administrator's screens (D-116).
   */
  const discoveryConfigured = getProductResearchProvider().key !== "none";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline"
        >
          <IconArrowLeft size={16} />
          Products
        </Link>
        <h1 className="mt-2 font-display text-h1 text-ink">Add product</h1>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-card border border-blue-300 bg-paper p-6 shadow-[var(--shadow-raise)]">
          <p className="text-body text-ink">
            Add a category before adding a product.
          </p>
          <p className="mt-2 text-meta text-ink/70">
            Every product belongs to one primary category.
          </p>
        </div>
      ) : (
        <ProductForm categories={categories} discoveryConfigured={discoveryConfigured} />
      )}
    </div>
  );
}
