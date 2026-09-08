import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  productImages,
  products,
  productVariants,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { uniqueSlug } from "@/lib/slug";
import type { ProductInputPayload } from "@/lib/validation/catalog";

/**
 * The statuses a shopper may see. `draft`, `scheduled`, and `archived` are
 * never returned by a public query — a scheduled product becomes visible only
 * once a staff member or a scheduled job moves it to a live status.
 */
export const PUBLIC_STATUSES = [
  "in_stock",
  "preorder_open",
  "preorder_closed",
  "coming_soon",
  "discontinued",
] as const;

export type AdminProductRow = {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  status: string;
  categoryName: string | null;
  variantCount: number;
  archivedAt: Date | null;
  updatedAt: Date;
};

export async function listProductsForAdmin(
  actor: SessionUser | null,
  options: { includeArchived?: boolean } = {},
): Promise<AdminProductRow[]> {
  requireStaff(actor);

  const rows = await db
    .select({
      id: products.id,
      title: products.title,
      slug: products.slug,
      brand: products.brand,
      status: products.status,
      categoryName: categories.name,
      archivedAt: products.archivedAt,
      updatedAt: products.updatedAt,
      variantCount: sql<number>`(
        select count(*)::int from ${productVariants}
        where ${productVariants.productId} = ${products.id}
          and ${productVariants.archivedAt} is null
      )`,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(options.includeArchived ? undefined : isNull(products.archivedAt))
    .orderBy(desc(products.updatedAt));

  return rows;
}

export async function getProductForAdmin(
  actor: SessionUser | null,
  productId: string,
) {
  requireStaff(actor);

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) return null;

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(productImages.sortOrder);

  return { ...product, images };
}

/**
 * Public product lookup by slug. Deliberately a separate function from the
 * admin one rather than a flag on it: this query structurally cannot return a
 * draft, an archived product, or the internal sourcing cost, so a missed
 * conditional cannot leak them (docs/BUSINESS_LOGIC.md).
 */
export async function getPublicProductBySlug(slug: string) {
  const [product] = await db
    .select({
      id: products.id,
      title: products.title,
      slug: products.slug,
      brand: products.brand,
      descriptionHtml: products.descriptionHtml,
      bulletFeatures: products.bulletFeatures,
      specTable: products.specTable,
      status: products.status,
      categoryId: products.categoryId,
      seoMetaTitle: products.seoMetaTitle,
      seoMetaDescription: products.seoMetaDescription,
    })
    .from(products)
    .where(
      and(
        eq(products.slug, slug),
        isNull(products.archivedAt),
        inArray(products.status, [...PUBLIC_STATUSES]),
      ),
    )
    .limit(1);

  if (!product) return null;

  const images = await db
    .select({
      id: productImages.id,
      url: productImages.url,
      altText: productImages.altText,
      sortOrder: productImages.sortOrder,
    })
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(productImages.sortOrder);

  return { ...product, images };
}

async function slugTaken(candidate: string, excludingId?: string) {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.slug, candidate))
    .limit(1);

  if (rows.length === 0) return false;
  return excludingId ? rows[0].id !== excludingId : true;
}

export async function createProduct(
  actor: SessionUser | null,
  input: ProductInputPayload,
) {
  const staff = requireStaff(actor);

  const slug =
    input.slug ?? (await uniqueSlug(input.title, (c) => slugTaken(c)));

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(products)
      .values({
        title: input.title,
        slug,
        categoryId: input.categoryId,
        brand: input.brand ?? null,
        descriptionHtml: input.descriptionHtml ?? null,
        bulletFeatures: input.bulletFeatures ?? null,
        specTable: input.specTable ?? null,
        tags: input.tags ?? null,
        seoMetaTitle: input.seoMetaTitle ?? null,
        seoMetaDescription: input.seoMetaDescription ?? null,
        status: input.status ?? "draft",
        publishAt: input.publishAt ?? null,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.created",
        entityType: "product",
        entityId: created.id,
        after: { title: created.title, status: created.status },
      },
      tx,
    );

    return created;
  });
}

export async function updateProduct(
  actor: SessionUser | null,
  productId: string,
  input: ProductInputPayload,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(products)
      .where(eq(products.id, productId));

    if (!before) throw new Error("That product no longer exists.");

    const slug =
      input.slug ??
      (before.title === input.title
        ? before.slug
        : await uniqueSlug(input.title, (c) => slugTaken(c, productId)));

    const [updated] = await tx
      .update(products)
      .set({
        title: input.title,
        slug,
        categoryId: input.categoryId,
        brand: input.brand ?? null,
        descriptionHtml: input.descriptionHtml ?? null,
        bulletFeatures: input.bulletFeatures ?? null,
        specTable: input.specTable ?? null,
        tags: input.tags ?? null,
        seoMetaTitle: input.seoMetaTitle ?? null,
        seoMetaDescription: input.seoMetaDescription ?? null,
        status: input.status ?? before.status,
        publishAt: input.publishAt ?? before.publishAt,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId))
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        before: { title: before.title, status: before.status, slug: before.slug },
        after: { title: updated.title, status: updated.status, slug: updated.slug },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Archive, never delete: orders reference products, and a hard delete would
 * break order history (CLAUDE.md section 7).
 */
export async function archiveProduct(
  actor: SessionUser | null,
  productId: string,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: products.status, archivedAt: products.archivedAt })
      .from(products)
      .where(eq(products.id, productId));

    if (!before) throw new Error("That product no longer exists.");

    const now = new Date();

    const [updated] = await tx
      .update(products)
      .set({ status: "archived", archivedAt: now, updatedAt: now })
      .where(eq(products.id, productId))
      .returning({ id: products.id, archivedAt: products.archivedAt });

    // Variants go with the product, so an archived product cannot be bought
    // through a variant that is still live.
    await tx
      .update(productVariants)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(productVariants.productId, productId));

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.archived",
        entityType: "product",
        entityId: productId,
        before,
        after: { status: "archived", archivedAt: updated.archivedAt },
      },
      tx,
    );

    return updated;
  });
}

export async function restoreProduct(
  actor: SessionUser | null,
  productId: string,
) {
  const staff = requireStaff(actor);

  return db.transaction(async (tx) => {
    const now = new Date();

    const [updated] = await tx
      .update(products)
      .set({ status: "draft", archivedAt: null, updatedAt: now })
      .where(eq(products.id, productId))
      .returning({ id: products.id, status: products.status });

    // Restored as a draft, and variants stay archived: bringing a product back
    // should not silently put stock or preorder capacity back on sale.
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        before: { status: "archived" },
        after: { status: "draft" },
      },
      tx,
    );

    return updated;
  });
}
