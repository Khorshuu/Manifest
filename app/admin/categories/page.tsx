import type { Metadata } from "next";
import { countProductsByCategoryForAdmin } from "@/lib/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  collectSubtreeIds,
  getCategoryTree,
  listCategoryAttributes,
  resolveCategoryAttributes,
  type CategoryNode,
} from "@/lib/catalog";
import { AttributeManager } from "./attribute-manager";
import { CategoryForm } from "./category-form";
import { CategoryTree, type TreeNode } from "./category-tree";

export const metadata: Metadata = { title: "Categories" };
export const dynamic = "force-dynamic";

function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

export default async function AdminCategoriesPage() {
  const user = await requireAdminPage("catalog.manage");
  const [tree, counts] = await Promise.all([
    getCategoryTree(),
    countProductsByCategoryForAdmin(user),
  ]);
  const options = flatten(tree);
  const firstCategoryId = options[0]?.id ?? "";

  const walk = (nodes: CategoryNode[]): TreeNode[] =>
    nodes.flatMap((node) => [
      {
        id: node.id,
        name: node.name,
        slug: node.slug,
        parentId: node.parentId,
        depth: node.depth,
        sortOrder: node.sortOrder,
        total: counts.get(node.id)?.total ?? 0,
        live: counts.get(node.id)?.live ?? 0,
        subtreeTotal: collectSubtreeIds(node).reduce(
          (sum, id) => sum + (counts.get(id)?.total ?? 0),
          0,
        ),
        childCount: node.children.length,
      },
      ...walk(node.children),
    ]);
  const nodes = walk(tree);

  // The first category renders complete, so the manager has nothing to fetch
  // until a different one is chosen.
  const [firstOwn, firstAll] = firstCategoryId
    ? await Promise.all([
        listCategoryAttributes(firstCategoryId),
        resolveCategoryAttributes(firstCategoryId),
      ])
    : [[], []];

  const firstOwnIds = new Set(firstOwn.map((attribute) => attribute.id));
  const uncategorised = counts.size === 0 ? 0 : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="admin-h1">Categories</h1>
        <p className="mt-0.5 text-meta text-ink/70">
          {nodes.length} categor{nodes.length === 1 ? "y" : "ies"} ·{" "}
          {tree.length} top-level. A product is filed in one category and
          appears in every shelf above it.
          {uncategorised === 0 ? " No products are filed yet." : ""}
        </p>
      </div>

      <section className="admin-card" aria-labelledby="how-categories-work">
        <h2 id="how-categories-work" className="admin-h2">How categories work</h2>
        <ol className="mt-3 grid gap-3 md:grid-cols-3">
          <li className="rounded-card border border-blue-200 bg-paper-raised p-3">
            <p className="text-meta font-semibold text-ink">1. Main categories</p>
            <p className="mt-1 text-[0.8125rem] text-ink/75">
              The big shelves, like <strong>Electronics</strong> or <strong>Beauty &amp; Care</strong>.
              They are the list in the ☰ menu at the top left, and the tiles under
              “Browse by kind” on the homepage.
            </p>
          </li>
          <li className="rounded-card border border-blue-200 bg-paper-raised p-3">
            <p className="text-meta font-semibold text-ink">2. Sub-categories</p>
            <p className="mt-1 text-[0.8125rem] text-ink/75">
              Smaller shelves inside a main one, like <strong>Electronics › Audio</strong>. In the
              menu they open under their main category; on the main category&rsquo;s page they show
              as buttons across the top. Use <strong>+ Sub</strong> on any row to add one.
            </p>
          </li>
          <li className="rounded-card border border-blue-200 bg-paper-raised p-3">
            <p className="text-meta font-semibold text-ink">3. Filing a product</p>
            <p className="mt-1 text-[0.8125rem] text-ink/75">
              Choose the most specific shelf in the product&rsquo;s <strong>Basics</strong> tab — e.g.
              Audio. It then also appears on every shelf above it (Electronics). Use ↑ ↓ to set the
              order shoppers see.
            </p>
          </li>
        </ol>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="admin-card min-w-0">
          <h2 className="admin-h2">Your categories</h2>
          {tree.length === 0 ? (
            <p className="mt-2 text-meta text-ink/70">
              No categories yet. Add the first one to start the tree.
            </p>
          ) : (
            <div className="mt-2">
              <CategoryTree nodes={nodes} parents={options} />
            </div>
          )}
        </section>

        <section className="admin-card min-w-0">
          <h2 className="admin-h2">Add a category</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink/70">
            Choose a parent to make it a subcategory.
          </p>
          <div className="mt-3">
            <CategoryForm parents={options} />
          </div>
        </section>
      </div>

      <section className="admin-card">
        <h2 className="admin-h2">Specifications by category</h2>
        <p className="mt-0.5 max-w-[80ch] text-[0.75rem] text-ink/70">
          What products on a shelf are asked to state about themselves — a
          refresh rate under Monitors, a fabric under Clothing. They appear on
          the product form as soon as a product is filed here and on the product
          page as its specifications table. Categories inherit everything
          defined above them.
        </p>
        <div className="mt-3 max-w-2xl">
          <AttributeManager
            categories={options}
            initial={{
              categoryId: firstCategoryId,
              own: firstOwn,
              inherited: firstAll.filter(
                (attribute) => !firstOwnIds.has(attribute.id),
              ),
            }}
          />
        </div>
      </section>
    </div>
  );
}
