import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  productImages,
  products,
  productVariants,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { uniqueSlug } from "@/lib/slug";
import type {
  ProductInputPayload,
  ProductPatchPayload,
} from "@/lib/validation/catalog";
import {
  resolveCategoryAttributes,
  validateAttributeValues,
} from "./category-attributes";
import {
  assertSkuAssignable,
  finalizeProductSku,
  recordPermanentSku,
} from "./sku";

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
  sku: string | null;
  status: string;
  /** False when staff have hidden the listing from the site's search. */
  searchable: boolean;
  categoryId: string | null;
  categoryName: string | null;
  variantCount: number;
  archivedAt: Date | null;
  updatedAt: Date;
  /** The first gallery photograph, for the list's thumbnail. */
  imageUrl: string | null;
  /** Lowest and highest regular price across live variants. */
  minPriceBdt: number | null;
  maxPriceBdt: number | null;
  /** Units on hand across in-stock variants; null when none track stock. */
  stockOnHand: number | null;
  /** Preorder places left across capped variants; null when none are capped. */
  preorderRemaining: number | null;
  /** How many live variants are preorders. */
  preorderVariants: number;
  /** Preorder variants with no capacity ceiling — never "out". */
  uncappedPreorders: number;
  /**
   * Variants running low: in stock at or below their threshold (3 when none
   * is set), or a capped preorder with 1–3 places left.
   */
  lowStockVariants: number;
  createdAt: Date;
};

/*
 * The subqueries below name their tables explicitly. Drizzle renders a column
 * of the outer table without its table name when the query has no join, and
 * inside a subquery a bare "id" silently means the subquery's own row — the
 * bug that once zeroed every customer's spend.
 */
const liveVariantOf = sql.raw(
  `v.product_id = "products"."id" and v.archived_at is null`,
);

export async function listProductsForAdmin(
  actor: SessionUser | null,
  options: { includeArchived?: boolean } = {},
): Promise<AdminProductRow[]> {
  requirePermission(actor, "catalog.manage");

  const rows = await db
    .select({
      id: products.id,
      title: products.title,
      slug: products.slug,
      brand: products.brand,
      sku: products.sku,
      status: products.status,
      searchable: products.searchable,
      categoryId: products.categoryId,
      categoryName: categories.name,
      archivedAt: products.archivedAt,
      updatedAt: products.updatedAt,
      variantCount: sql<number>`(
        select count(*)::int from ${productVariants} v where ${liveVariantOf}
      )`,
      imageUrl: sql<string | null>`(
        select i.url from ${productImages} i
        where i.product_id = "products"."id" and i.kind = 'gallery'
        order by i.sort_order, i.created_at limit 1
      )`,
      minPriceBdt: sql<number | null>`(
        select min(v.price_bdt)::int from ${productVariants} v where ${liveVariantOf}
      )`,
      maxPriceBdt: sql<number | null>`(
        select max(v.price_bdt)::int from ${productVariants} v where ${liveVariantOf}
      )`,
      stockOnHand: sql<number | null>`(
        select sum(v.stock_quantity)::int from ${productVariants} v
        where ${liveVariantOf} and v.fulfillment_mode = 'in_stock'
      )`,
      preorderRemaining: sql<number | null>`(
        select sum(v.preorder_capacity - v.preorder_reserved)::int from ${productVariants} v
        where ${liveVariantOf} and v.fulfillment_mode = 'preorder' and v.preorder_capacity is not null
      )`,
      preorderVariants: sql<number>`(
        select count(*)::int from ${productVariants} v
        where ${liveVariantOf} and v.fulfillment_mode = 'preorder'
      )`,
      uncappedPreorders: sql<number>`(
        select count(*)::int from ${productVariants} v
        where ${liveVariantOf} and v.is_enabled and v.fulfillment_mode = 'preorder'
          and v.preorder_capacity is null
      )`,
      lowStockVariants: sql<number>`(
        select count(*)::int from ${productVariants} v
        where ${liveVariantOf} and v.is_enabled and (
          (v.fulfillment_mode = 'in_stock' and v.stock_quantity > 0
            and v.stock_quantity <= coalesce(v.low_stock_threshold, 3))
          or (v.fulfillment_mode = 'preorder' and v.preorder_capacity is not null
            and v.preorder_capacity - v.preorder_reserved between 1 and 3)
        )
      )`,
      createdAt: products.createdAt,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(options.includeArchived ? undefined : isNull(products.archivedAt))
    .orderBy(desc(products.updatedAt));

  return rows.map((row) => ({
    ...row,
    variantCount: Number(row.variantCount),
    minPriceBdt: row.minPriceBdt === null ? null : Number(row.minPriceBdt),
    maxPriceBdt: row.maxPriceBdt === null ? null : Number(row.maxPriceBdt),
    stockOnHand: row.stockOnHand === null ? null : Number(row.stockOnHand),
    preorderRemaining:
      row.preorderRemaining === null ? null : Number(row.preorderRemaining),
    preorderVariants: Number(row.preorderVariants),
    uncappedPreorders: Number(row.uncappedPreorders),
    lowStockVariants: Number(row.lowStockVariants),
  }));
}

export async function getProductForAdmin(
  actor: SessionUser | null,
  productId: string,
) {
  requirePermission(actor, "catalog.manage");

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) return null;

  const allImages = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(productImages.sortOrder);

  // `images` stays the gallery, so every existing caller keeps the meaning it
  // was written against; the lifestyle set is a second, separate list.
  return {
    ...product,
    images: allImages.filter((image) => image.kind !== "lifestyle"),
    lifestyleImages: allImages.filter((image) => image.kind === "lifestyle"),
  };
}

/**
 * Public product lookup by slug. Deliberately a separate function from the
 * admin one rather than a flag on it: this query structurally cannot return a
 * draft, an archived product, or the internal sourcing cost, so a missed
 * conditional cannot leak them (docs/BUSINESS_LOGIC.md).
 */
export async function getPublicProductBySlug(
  slug: string,
  /**
   * Staff preview only: the caller must have checked `catalog.manage` first.
   * Lets a draft or scheduled listing render so it can be checked before it
   * goes live; nothing public ever passes this.
   */
  options: { includeUnpublished?: boolean } = {},
) {
  const [product] = await db
    .select({
      id: products.id,
      title: products.title,
      slug: products.slug,
      brand: products.brand,
      descriptionHtml: products.descriptionHtml,
      bulletFeatures: products.bulletFeatures,
      specTable: products.specTable,
      measurements: products.measurements,
      boxContents: products.boxContents,
      warranty: products.warranty,
      compliance: products.compliance,
      details: products.details,
      attributeValues: products.attributeValues,
      videoUrl: products.videoUrl,
      sku: products.sku,
      identifierType: products.identifierType,
      identifierValue: products.identifierValue,
      tags: products.tags,
      status: products.status,
      categoryId: products.categoryId,
      seoMetaTitle: products.seoMetaTitle,
      seoMetaDescription: products.seoMetaDescription,
      seoNoIndex: products.seoNoIndex,
      canonicalUrl: products.canonicalUrl,
    })
    .from(products)
    .where(
      options.includeUnpublished
        ? eq(products.slug, slug)
        : and(
            eq(products.slug, slug),
            isNull(products.archivedAt),
            inArray(products.status, [...PUBLIC_STATUSES]),
          ),
    )
    .limit(1);

  if (!product) return null;

  const allImages = await db
    .select({
      id: productImages.id,
      url: productImages.url,
      altText: productImages.altText,
      sortOrder: productImages.sortOrder,
      kind: productImages.kind,
    })
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(productImages.sortOrder);

  return {
    ...product,
    images: allImages.filter((image) => image.kind !== "lifestyle"),
    lifestyleImages: allImages.filter((image) => image.kind === "lifestyle"),
  };
}

/**
 * Refuses a SKU another product already carries.
 *
 * Checked here as well as by the partial unique index, so the admin gets a
 * sentence naming the clash rather than a database error — and the index is
 * still what makes it true under a race.
 */
/**
 * A SKU may go on a product only if no other product or variant has it, no
 * other admin's unsaved form is holding it, and it was never made permanent
 * for a different product (lib/catalog/sku.ts, D-037).
 */
async function assertSkuIsFree(
  sku: string,
  excludingId?: string,
  allowReservationId?: string | null,
) {
  try {
    await assertSkuAssignable(db, sku, {
      excludingProductId: excludingId,
      allowReservationId,
    });
  } catch (error) {
    throw new DuplicateSkuError(error instanceof Error ? error.message : String(error));
  }
}

export class DuplicateSkuError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "DuplicateSkuError";
  }
}

/**
 * Turns a submitted payload into the columns to write.
 *
 * Only the keys actually present are returned, which is what makes a partial
 * save safe: a section of the admin form sends its own fields, and every
 * field it did not send keeps the value already stored.
 */
function columnsFrom(
  input: ProductPatchPayload,
): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  const copy = <K extends keyof ProductPatchPayload>(key: K) => {
    if (input[key] !== undefined) columns[key as string] = input[key];
  };

  (
    [
      "categoryId",
      "brand",
      "sku",
      "identifierType",
      "identifierValue",
      "descriptionHtml",
      "bulletFeatures",
      "boxContents",
      "specTable",
      "measurements",
      "warranty",
      "compliance",
      "details",
      "videoUrl",
      "tags",
      "searchKeywords",
      "searchable",
      "searchBoost",
      "seoFocusKeyword",
      "seoMetaTitle",
      "seoMetaDescription",
      "seoNoIndex",
      "canonicalUrl",
      "publishAt",
      "unpublishAt",
    ] as const
  ).forEach(copy);

  return columns;
}

/**
 * Checks the category-specific specifications against the definitions of the
 * category the product will actually be in once this save lands — which is
 * the submitted category when one was sent, not the one it is in now.
 */
async function cleanAttributeValues(
  input: ProductPatchPayload,
  categoryId: string,
) {
  if (input.attributeValues === undefined) return undefined;
  if (input.attributeValues === null) return null;

  const definitions = await resolveCategoryAttributes(categoryId);
  return validateAttributeValues(definitions, input.attributeValues);
}

export async function slugTaken(candidate: string, excludingId?: string) {
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
  const staff = requirePermission(actor, "catalog.manage");

  const slug =
    input.slug ?? (await uniqueSlug(input.title, (c) => slugTaken(c)));

  /*
   * The SKU the Add Product form was holding, unless staff typed another. A
   * product saved with no SKU at all still gives its hold back.
   */
  const reservationId = input.skuReservationId ?? null;
  if (input.sku) await assertSkuIsFree(input.sku, undefined, reservationId);

  const attributeValues = await cleanAttributeValues(input, input.categoryId);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(products)
      .values({
        ...columnsFrom(input),
        title: input.title,
        slug,
        categoryId: input.categoryId,
        attributeValues: attributeValues ?? null,
        status: input.status ?? "draft",
      })
      .returning();

    // Same transaction as the insert: if the product fails to save, the hold
    // is untouched and the admin can retry with the same SKU.
    if (created.sku) {
      await finalizeProductSku(tx, {
        actorId: staff.id,
        productId: created.id,
        sku: created.sku,
        reservationId,
      });
    } else if (reservationId) {
      await tx.execute(sql`update sku_reservations
        set status = 'released', released_at = now()
        where id = ${reservationId} and reserved_by = ${staff.id} and status = 'reserved'`);
    }

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

/**
 * Applies a partial change to a product.
 *
 * Only the fields the caller sent are written. That is what lets the admin
 * page be a set of independent sections instead of one enormous form that has
 * to re-post every column it does not edit — the arrangement this replaced,
 * where a section that forgot to echo a field back silently erased it.
 */
export async function updateProduct(
  actor: SessionUser | null,
  productId: string,
  input: ProductPatchPayload,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [current] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId));

  if (!current) throw new Error("That product no longer exists.");

  if (input.sku) await assertSkuIsFree(input.sku, productId);

  const attributeValues = await cleanAttributeValues(
    input,
    input.categoryId ?? current.categoryId,
  );

  return db.transaction(async (tx) => {
    const before = current;

    const title = input.title ?? before.title;

    /*
     * The slug is only rebuilt when the title changed and no slug was sent.
     * A published URL is not something to change behind a shopper's back, but
     * a product still being drafted should not keep the slug of its first
     * working title either — so a staff member can always set it by hand.
     */
    const slug =
      input.slug ??
      (before.title === title
        ? before.slug
        : await uniqueSlug(title, (c) => slugTaken(c, productId)));

    const [updated] = await tx
      .update(products)
      .set({
        ...columnsFrom(input),
        ...(attributeValues !== undefined ? { attributeValues } : {}),
        title,
        slug,
        status: input.status ?? before.status,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId))
      .returning();

    // A SKU a saved product has carried stays spent: both the old and the new
    // one are on record, so neither can be generated for another product.
    if (updated.sku && updated.sku !== before.sku) {
      if (before.sku) await recordPermanentSku(tx, staff.id, productId, before.sku);
      await recordPermanentSku(tx, staff.id, productId, updated.sku);
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        before: {
          title: before.title,
          status: before.status,
          slug: before.slug,
          searchable: before.searchable,
          searchBoost: before.searchBoost,
        },
        after: {
          title: updated.title,
          status: updated.status,
          slug: updated.slug,
          searchable: updated.searchable,
          searchBoost: updated.searchBoost,
        },
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
  const staff = requirePermission(actor, "catalog.manage");

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
  const staff = requirePermission(actor, "catalog.manage");

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
