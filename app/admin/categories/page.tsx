import type { Metadata } from "next";
import { getCategoryTree, type CategoryNode } from "@/lib/catalog";
import { CategoryForm } from "./category-form";

export const metadata: Metadata = { title: "Categories" };
export const dynamic = "force-dynamic";

function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

function CategoryRows({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <>
      {nodes.map((node) => (
        <li key={node.id}>
          <div
            className="flex items-baseline gap-3 border-b border-blue-300 py-3"
            style={{ paddingLeft: `${node.depth * 24}px` }}
          >
            <span className="text-body text-ink">{node.name}</span>
            <span className="text-meta text-ink/70">/{node.slug}</span>
          </div>
          {node.children.length > 0 ? (
            <ul>
              <CategoryRows nodes={node.children} />
            </ul>
          ) : null}
        </li>
      ))}
    </>
  );
}

export default async function AdminCategoriesPage() {
  const tree = await getCategoryTree();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-meta text-blue-600">Catalog</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Categories</h1>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
        <section>
          <h2 className="font-display text-h2 text-ink">Current tree</h2>
          {tree.length === 0 ? (
            <p className="mt-4 text-body text-ink/70">
              No categories yet. Add the first one to start the tree.
            </p>
          ) : (
            <ul
              aria-label="Category tree"
              className="mt-4 border-t border-blue-300"
            >
              <CategoryRows nodes={tree} />
            </ul>
          )}
        </section>

        <section>
          <h2 className="font-display text-h2 text-ink">Add a category</h2>
          <div className="mt-4">
            <CategoryForm parents={flatten(tree)} />
          </div>
        </section>
      </div>
    </div>
  );
}
