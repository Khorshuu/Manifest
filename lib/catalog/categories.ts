import { asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, products } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

export type Category = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
};

export type CategoryNode = Category & {
  children: CategoryNode[];
  depth: number;
};

export class CategoryInUseError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CategoryInUseError";
  }
}

export class CycleError extends Error {
  readonly status = 400;

  constructor() {
    super("A category cannot be moved inside itself.");
    this.name = "CycleError";
  }
}

export async function listCategories(): Promise<Category[]> {
  return db
    .select({
      id: categories.id,
      parentId: categories.parentId,
      name: categories.name,
      slug: categories.slug,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
}

/**
 * Builds the tree in one pass over a single query, rather than recursing with
 * a query per level — the tree is rendered on most pages, so an N+1 here
 * would be felt everywhere.
 */
export function buildCategoryTree(rows: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [], depth: 0 });
  }

  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const assignDepth = (node: CategoryNode, depth: number) => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);

  return roots;
}

export async function getCategoryTree(): Promise<CategoryNode[]> {
  return buildCategoryTree(await listCategories());
}

/** Root-to-node path, for breadcrumbs. */
export function findCategoryPath(
  tree: CategoryNode[],
  categoryId: string,
): CategoryNode[] {
  for (const node of tree) {
    if (node.id === categoryId) return [node];
    const nested = findCategoryPath(node.children, categoryId);
    if (nested.length > 0) return [node, ...nested];
  }
  return [];
}

/** Every descendant id, plus the category itself — used to filter listings. */
export function collectSubtreeIds(node: CategoryNode): string[] {
  return [node.id, ...node.children.flatMap(collectSubtreeIds)];
}

/** Root-to-node path for a slug, or an empty path when nothing has it. */
export function findCategoryPathBySlug(
  tree: CategoryNode[],
  slug: string,
): CategoryNode[] {
  for (const node of tree) {
    if (node.slug === slug) return [node];
    const nested = findCategoryPathBySlug(node.children, slug);
    if (nested.length > 0) return [node, ...nested];
  }
  return [];
}

/**
 * A category's own count plus everything beneath it, from per-category
 * counts. A shelf holds its children's products, so its number is theirs.
 */
export function subtreeCount(
  node: CategoryNode,
  counts: Record<string, number>,
): number {
  return collectSubtreeIds(node).reduce(
    (total, id) => total + (counts[id] ?? 0),
    0,
  );
}

async function assertNoCycle(categoryId: string, parentId: string | null) {
  if (!parentId) return;
  if (parentId === categoryId) throw new CycleError();

  const rows = await listCategories();
  const byId = new Map(rows.map((row) => [row.id, row]));

  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === categoryId) throw new CycleError();
    cursor = byId.get(cursor)?.parentId ?? null;
  }
}

export type CategoryInput = {
  name: string;
  slug: string;
  parentId?: string | null;
  sortOrder?: number;
};

export async function createCategory(
  actor: SessionUser | null,
  input: CategoryInput,
): Promise<Category> {
  const staff = requirePermission(actor, "catalog.manage");
  await assertNoCycle("", input.parentId ?? null);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(categories)
      .values({
        name: input.name,
        slug: input.slug,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning({
        id: categories.id,
        parentId: categories.parentId,
        name: categories.name,
        slug: categories.slug,
        sortOrder: categories.sortOrder,
      });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "category.created",
        entityType: "category",
        entityId: created.id,
        after: created,
      },
      tx,
    );

    return created;
  });
}

export async function updateCategory(
  actor: SessionUser | null,
  categoryId: string,
  input: CategoryInput,
): Promise<Category> {
  const staff = requirePermission(actor, "catalog.manage");
  await assertNoCycle(categoryId, input.parentId ?? null);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId));

    if (!before) throw new Error("That category no longer exists.");

    const [updated] = await tx
      .update(categories)
      .set({
        name: input.name,
        slug: input.slug,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? before.sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(categories.id, categoryId))
      .returning({
        id: categories.id,
        parentId: categories.parentId,
        name: categories.name,
        slug: categories.slug,
        sortOrder: categories.sortOrder,
      });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "category.updated",
        entityType: "category",
        entityId: categoryId,
        before,
        after: updated,
      },
      tx,
    );

    return updated;
  });
}

/**
 * Categories are only removable while nothing depends on them. A category with
 * products or children is refused rather than cascading, because cascading
 * here would silently orphan a live listing.
 */
export async function deleteCategory(
  actor: SessionUser | null,
  categoryId: string,
): Promise<void> {
  const staff = requirePermission(actor, "catalog.manage");

  const [{ childCount }] = await db
    .select({ childCount: sql<number>`count(*)::int` })
    .from(categories)
    .where(eq(categories.parentId, categoryId));

  if (childCount > 0) {
    throw new CategoryInUseError(
      "Move or remove the subcategories before removing this category.",
    );
  }

  const [{ productCount }] = await db
    .select({ productCount: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.categoryId, categoryId));

  if (productCount > 0) {
    throw new CategoryInUseError(
      `Move the ${productCount} product${productCount === 1 ? "" : "s"} in this category first.`,
    );
  }

  await db.delete(categories).where(eq(categories.id, categoryId));

  await recordAudit({
    actorUserId: staff.id,
    action: "category.updated",
    entityType: "category",
    entityId: categoryId,
    before: { deleted: false },
    after: { deleted: true },
  });
}

export async function getRootCategories(): Promise<Category[]> {
  return db
    .select({
      id: categories.id,
      parentId: categories.parentId,
      name: categories.name,
      slug: categories.slug,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(isNull(categories.parentId))
    .orderBy(asc(categories.sortOrder));
}
