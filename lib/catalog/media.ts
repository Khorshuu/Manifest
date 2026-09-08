import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/authorize";
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
  input: UploadInput & { altText: string },
) {
  const staff = requireStaff(actor);

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
    const [{ nextOrder }] = await tx
      .select({
        nextOrder: sql<number>`coalesce(max(${productImages.sortOrder}) + 1, 0)::int`,
      })
      .from(productImages)
      .where(eq(productImages.productId, productId));

    const [created] = await tx
      .insert(productImages)
      .values({
        productId,
        url: stored.url,
        altText,
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

export async function listProductImages(productId: string) {
  return db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder));
}

export async function removeProductImage(
  actor: SessionUser | null,
  imageId: string,
) {
  const staff = requireStaff(actor);

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

/** Moves an image up or down the gallery order. */
export async function reorderProductImage(
  actor: SessionUser | null,
  imageId: string,
  direction: "up" | "down",
) {
  requireStaff(actor);

  const [image] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));

  if (!image) throw new MediaError("That image no longer exists.");

  const siblings = await listProductImages(image.productId);
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
