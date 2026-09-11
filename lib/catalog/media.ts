import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { getMediaProvider, type UploadInput } from "@/lib/providers/media";

/**
 * Product media.
 *
 * Only staff may add or remove product photography, enforced here rather than
 * only at the route — this is the restriction MASTER_PRODUCT_SPEC.md calls out
 * by name.
 */

export class MediaError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export async function addProductImage(
  actor: SessionUser | null,
  productId: string,
  input: UploadInput & { altText: string; kind?: "gallery" | "lifestyle" },
) {
  const staff = requirePermission(actor, "catalog.manage");
  const kind = input.kind ?? "gallery";

  const altText = input.altText.trim();
  if (altText.length === 0) {
    // Alternative text is not optional: an image without it is unusable to
    // anyone with a screen reader (docs/DESIGN_GUIDELINES.md).
    throw new MediaError(
      "Describe the photograph, so it works for someone using a screen reader.",
    );
  }

  const stored = await getMediaProvider().upload(input);

  return db.transaction(async (tx) => {
    // Each kind orders itself, so adding a lifestyle shot never moves the
    // gallery and the main image stays the main image.
    const [{ nextOrder }] = await tx
      .select({
        nextOrder: sql<number>`coalesce(max(${productImages.sortOrder}) + 1, 0)::int`,
      })
      .from(productImages)
      .where(
        and(
          eq(productImages.productId, productId),
          eq(productImages.kind, kind),
        ),
      );

    const [created] = await tx
      .insert(productImages)
      .values({
        productId,
        url: stored.url,
        altText,
        kind,
        sortOrder: nextOrder,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        after: { imageAdded: stored.url, bytes: stored.bytes },
      },
      tx,
    );

    return created;
  });
}

export async function listProductImages(
  productId: string,
  kind?: "gallery" | "lifestyle",
) {
  return db
    .select()
    .from(productImages)
    .where(
      kind
        ? and(eq(productImages.productId, productId), eq(productImages.kind, kind))
        : eq(productImages.productId, productId),
    )
    .orderBy(asc(productImages.sortOrder));
}

/**
 * Rewrites the order of one product's images from a list of ids.
 *
 * This is what drag-and-drop saves: one call carrying the arrangement the
 * admin can see, rather than a run of "move up" calls that each depend on the
 * last one having landed. Ids that are not this product's images are refused
 * rather than ignored, and any image left out of the list keeps its place
 * after the ones named.
 */
export async function setProductImageOrder(
  actor: SessionUser | null,
  productId: string,
  orderedIds: string[],
) {
  const staff = requirePermission(actor, "catalog.manage");

  const existing = await listProductImages(productId);
  const byId = new Map(existing.map((image) => [image.id, image]));

  for (const id of orderedIds) {
    if (!byId.has(id)) {
      throw new MediaError("That image does not belong to this product.");
    }
  }

  const named = orderedIds.map((id) => byId.get(id)!);
  const kind = named[0]?.kind ?? "gallery";

  if (named.some((image) => image.kind !== kind)) {
    throw new MediaError("Gallery and lifestyle images are ordered separately.");
  }

  const rest = existing.filter(
    (image) => image.kind === kind && !orderedIds.includes(image.id),
  );

  await db.transaction(async (tx) => {
    for (const [position, image] of [...named, ...rest].entries()) {
      await tx
        .update(productImages)
        .set({ sortOrder: position })
        .where(eq(productImages.id, image.id));
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        after: { imagesReordered: kind },
      },
      tx,
    );
  });
}

/** Corrects an image's description without re-uploading the file. */
export async function updateProductImageAltText(
  actor: SessionUser | null,
  imageId: string,
  altText: string,
) {
  requirePermission(actor, "catalog.manage");

  const text = altText.trim();
  if (text.length === 0) {
    throw new MediaError(
      "Describe the photograph, so it works for someone using a screen reader.",
    );
  }

  const [updated] = await db
    .update(productImages)
    .set({ altText: text })
    .where(eq(productImages.id, imageId))
    .returning();

  if (!updated) throw new MediaError("That image no longer exists.");

  return updated;
}

export async function removeProductImage(
  actor: SessionUser | null,
  imageId: string,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [image] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));

  if (!image) throw new MediaError("That image no longer exists.");

  await db.delete(productImages).where(eq(productImages.id, imageId));

  // The row is what the site reads, so it goes first; a file left behind is
  // untidy, a row pointing at a deleted file is a broken page.
  const key = image.url.split("/").pop();
  if (key) await getMediaProvider().delete(key).catch(() => undefined);

  await recordAudit({
    actorUserId: staff.id,
    action: "product.updated",
    entityType: "product",
    entityId: image.productId,
    before: { imageUrl: image.url },
    after: { imageRemoved: true },
  });
}

/**
 * Makes one image the main one.
 *
 * The first image is what the card, the hero fallback and the top of the
 * product page all show, and reaching it by pressing "move up" four times is
 * how a gallery ends up in the wrong order. Every other image keeps its
 * relative order behind it, so promoting one is not a reshuffle.
 */
export async function makeProductImagePrimary(
  actor: SessionUser | null,
  imageId: string,
) {
  const staff = requirePermission(actor, "catalog.manage");

  const [image] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));

  if (!image) throw new MediaError("That image no longer exists.");

  const siblings = await listProductImages(
    image.productId,
    image.kind as "gallery" | "lifestyle",
  );
  if (siblings[0]?.id === imageId) return;

  const order = [image, ...siblings.filter((row) => row.id !== imageId)];

  await db.transaction(async (tx) => {
    for (const [position, row] of order.entries()) {
      await tx
        .update(productImages)
        .set({ sortOrder: position })
        .where(eq(productImages.id, row.id));
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: image.productId,
        after: { mainImage: image.url },
      },
      tx,
    );
  });
}

/** Moves an image up or down the gallery order. */
export async function reorderProductImage(
  actor: SessionUser | null,
  imageId: string,
  direction: "up" | "down",
) {
  requirePermission(actor, "catalog.manage");

  const [image] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));

  if (!image) throw new MediaError("That image no longer exists.");

  const siblings = await listProductImages(
    image.productId,
    image.kind as "gallery" | "lifestyle",
  );
  const index = siblings.findIndex((row) => row.id === imageId);
  const swapWith = direction === "up" ? index - 1 : index + 1;

  if (swapWith < 0 || swapWith >= siblings.length) return;

  const other = siblings[swapWith];

  await db.transaction(async (tx) => {
    await tx
      .update(productImages)
      .set({ sortOrder: other.sortOrder })
      .where(eq(productImages.id, image.id));

    await tx
      .update(productImages)
      .set({ sortOrder: image.sortOrder })
      .where(eq(productImages.id, other.id));
  });
}
