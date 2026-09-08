import type { Metadata } from "next";
import Link from "next/link";
import { getCategoryTree, type CategoryNode } from "@/lib/catalog";
import { ProductForm } from "./product-form";

export const metadata: Metadata = { title: "Add product" };
export const dynamic = "force-dynamic";

/** Flattens the tree into indented options, so nesting is visible in a select. */
function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

export default async function NewProductPage() {
  const tree = await getCategoryTree();
  const categories = flatten(tree);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-meta text-blue-600">
          <Link href="/admin/products" className="hover:underline">
            Products
          </Link>
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Add product</h1>
      </div>

      {categories.length === 0 ? (
        <div className="border border-blue-300 p-6">
          <p className="text-body text-ink">
            Add a category before adding a product.
          </p>
          <p className="mt-2 text-meta text-ink/70">
            Every product belongs to one primary category.
          </p>
        </div>
      ) : (
        <ProductForm categories={categories} />
      )}
    </div>
  );
}
