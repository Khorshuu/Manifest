import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  products,
  seoFieldHistory,
  users,
  type CategorySeoField,
  type SeoChangeField,
  type SeoChangeWorkflow,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import { isSeoField, seoFieldLabel } from "./fields";

/**
 * The SEO change history (D-098).
 *
 * One append-only record of every change to a listing's or a shelf's SEO
 * fields: what changed, from what to what, when, who did it, why, and through
 * which workflow. Stage 4 built this for listings; Stage 6 widened it to
 * shelves and added the workflow, because a before-and-after comparison needs
 * something to anchor to and "somebody changed something around then" is not
 * an anchor.
 *
 * Nothing rewrites history. The table refuses updates and deletes in the
 * database (migration 0033), so a correction is a new row, not an edit.
 */

export type SeoChange = {
  id: string;
  entityType: "product" | "category";
  entityId: string;
  /** The listing or shelf name, for a screen. */
  entityName: string;
  /** The address of the page it changed, when there is one. */
  path: string | null;
  field: SeoChangeField;
  beforeValue: string | null;
  afterValue: string | null;
  beforeState: string | null;
  afterState: string | null;
  actor: string | null;
  reason: string;
  workflow: SeoChangeWorkflow;
  changedAt: Date;
};

const CATEGORY_FIELD_LABELS: Record<CategorySeoField, string> = {
  seoMetaTitle: "SEO title",
  seoMetaDescription: "Meta description",
  canonicalUrl: "Canonical address",
  seoNoIndex: "Hidden from search",
  slug: "Web address",
  name: "Shelf name",
  introHtml: "Shelf copy",
};

/**
 * A field's name in words. A listing's fields already have labels, and a
 * shelf's are named here; nothing should reach a screen as `seoFocusKeyword`.
 */
export function changeFieldLabel(field: SeoChangeField): string {
  if (isSeoField(field)) return seoFieldLabel(field);
  return (CATEGORY_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Records what changed on a shelf. Written inside the transaction that writes
 * the values, so a rolled-back save leaves no history claiming it happened.
 *
 * A shelf carries no per-field state machine — that is a listing thing — so
 * these rows record no state rather than inventing one.
 */
export async function recordCategoryChanges(
  executor: Executor,
  categoryId: string,
  actorId: string | null,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  input: { fields: readonly CategorySeoField[]; reason: string; workflow?: SeoChangeWorkflow },
): Promise<CategorySeoField[]> {
  const written: CategorySeoField[] = [];
  for (const field of input.fields) {
    const from = asText(before[field]);
    const to = asText(after[field]);
    if (from === to) continue;
    await executor.insert(seoFieldHistory).values({
      entityType: "category",
      categoryId,
      field,
      beforeValue: from,
      afterValue: to,
      actorUserId: actorId,
      reason: input.reason.slice(0, 300),
      workflow: input.workflow ?? "editor",
    });
    written.push(field);
  }
  return written;
}

type HistoryRow = {
  id: string;
  entityType: "product" | "category";
  productId: string | null;
  categoryId: string | null;
  field: SeoChangeField;
  beforeValue: string | null;
  afterValue: string | null;
  beforeState: string | null;
  afterState: string | null;
  actorUserId: string | null;
  reason: string;
  workflow: SeoChangeWorkflow;
  createdAt: Date;
};

async function decorate(executor: Executor, rows: HistoryRow[]): Promise<SeoChange[]> {
  const productIds = [...new Set(rows.map((row) => row.productId).filter((id): id is string => Boolean(id)))];
  const categoryIds = [...new Set(rows.map((row) => row.categoryId).filter((id): id is string => Boolean(id)))];
  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];

  const listings: { id: string; title: string; slug: string }[] =
    productIds.length === 0
      ? []
      : await executor
          .select({ id: products.id, title: products.title, slug: products.slug })
          .from(products)
          .where(inArray(products.id, productIds));
  const shelves: { id: string; name: string; slug: string }[] =
    categoryIds.length === 0
      ? []
      : await executor
          .select({ id: categories.id, name: categories.name, slug: categories.slug })
          .from(categories)
          .where(inArray(categories.id, categoryIds));
  const actors: { id: string; email: string }[] =
    actorIds.length === 0
      ? []
      : await executor.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, actorIds));

  const listingById = new Map(listings.map((row) => [row.id, row]));
  const shelfById = new Map(shelves.map((row) => [row.id, row]));
  const actorById = new Map(actors.map((row) => [row.id, row.email]));

  return rows.map((row) => {
    const listing = row.productId ? listingById.get(row.productId) : undefined;
    const shelf = row.categoryId ? shelfById.get(row.categoryId) : undefined;
    return {
      id: row.id,
      entityType: row.entityType,
      entityId: (row.productId ?? row.categoryId)!,
      entityName: listing?.title ?? shelf?.name ?? "(removed)",
      path: listing ? `/products/${listing.slug}` : shelf ? `/categories/${shelf.slug}` : null,
      field: row.field,
      beforeValue: row.beforeValue,
      afterValue: row.afterValue,
      beforeState: row.beforeState,
      afterState: row.afterState,
      actor: row.actorUserId ? (actorById.get(row.actorUserId) ?? null) : null,
      reason: row.reason,
      workflow: row.workflow,
      changedAt: row.createdAt,
    };
  });
}

const HISTORY_COLUMNS = {
  id: seoFieldHistory.id,
  entityType: seoFieldHistory.entityType,
  productId: seoFieldHistory.productId,
  categoryId: seoFieldHistory.categoryId,
  field: seoFieldHistory.field,
  beforeValue: seoFieldHistory.beforeValue,
  afterValue: seoFieldHistory.afterValue,
  beforeState: seoFieldHistory.beforeState,
  afterState: seoFieldHistory.afterState,
  actorUserId: seoFieldHistory.actorUserId,
  reason: seoFieldHistory.reason,
  workflow: seoFieldHistory.workflow,
  createdAt: seoFieldHistory.createdAt,
};

/** The most recent changes across the catalogue, newest first. */
export async function recentSeoChanges(
  actor: SessionUser | null,
  options: { limit?: number; since?: Date; executor?: Executor } = {},
): Promise<SeoChange[]> {
  requirePermission(actor, "seo.view");
  const executor = options.executor ?? db;
  const rows: HistoryRow[] = await executor
    .select(HISTORY_COLUMNS)
    .from(seoFieldHistory)
    .where(options.since ? gte(seoFieldHistory.createdAt, options.since) : sql`true`)
    .orderBy(desc(seoFieldHistory.createdAt))
    .limit(options.limit ?? 50);
  return decorate(executor, rows);
}

/** One listing's or shelf's changes, newest first. */
export async function seoChangesFor(
  actor: SessionUser | null,
  entity: { productId?: string; categoryId?: string },
  options: { limit?: number; executor?: Executor } = {},
): Promise<SeoChange[]> {
  requirePermission(actor, "seo.view");
  const executor = options.executor ?? db;
  const where = entity.productId
    ? eq(seoFieldHistory.productId, entity.productId)
    : entity.categoryId
      ? eq(seoFieldHistory.categoryId, entity.categoryId)
      : sql`false`;
  const rows: HistoryRow[] = await executor
    .select(HISTORY_COLUMNS)
    .from(seoFieldHistory)
    .where(where)
    .orderBy(desc(seoFieldHistory.createdAt))
    .limit(options.limit ?? 50);
  return decorate(executor, rows);
}
