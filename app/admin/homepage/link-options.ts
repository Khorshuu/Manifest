import { getCategoryTree, type CategoryNode } from "@/lib/catalog";

export type LinkOption = { label: string; href: string };

/**
 * Suggested destinations for a hero or tile: the main listings and every
 * category, so staff can pick a real page instead of typing a path from
 * memory. Any other path or a full address can still be typed.
 */
export async function listCategoryTreeForLinks(): Promise<LinkOption[]> {
  const tree = await getCategoryTree();

  const walk = (nodes: CategoryNode[]): LinkOption[] =>
    nodes.flatMap((node) => [
      { label: `${"— ".repeat(node.depth)}${node.name}`, href: `/categories/${node.slug}` },
      ...walk(node.children),
    ]);

  return [
    { label: "Everything", href: "/search" },
    { label: "Newest first", href: "/search?sort=newest" },
    { label: "Open preorders", href: "/search?preorder=1" },
    { label: "On sale", href: "/search?deal=1" },
    ...walk(tree),
  ];
}
