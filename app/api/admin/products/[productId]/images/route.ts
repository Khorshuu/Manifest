import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  addProductImage,
  makeProductImagePrimary,
  removeProductImage,
  reorderProductImage,
  setProductImageOrder,
  updateProductImageAltText,
} from "@/lib/catalog";
import { MAX_UPLOAD_BYTES } from "@/lib/providers/media";

/**
 * Product media upload.
 *
 * Multipart rather than JSON, so the browser streams the file. The size is
 * checked before the bytes are read into memory, and the format is established
 * from those bytes rather than from the declared type.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/images">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES * 2) {
      return NextResponse.json(
        { error: "That file is too large." },
        { status: 413 },
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    const altText = String(form.get("altText") ?? "");
    // Anything but the literal "lifestyle" is the gallery: an unknown value
    // must not be able to reach the column's check constraint.
    const kind = form.get("kind") === "lifestyle" ? "lifestyle" : "gallery";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a file." }, { status: 400 });
    }

    const data = Buffer.from(await file.arrayBuffer());

    const image = await addProductImage(user, productId, {
      data,
      originalName: file.name,
      contentType: file.type,
      altText,
      kind,
    });

    return NextResponse.json({ image }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const mutateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove"), imageId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("reorder"),
      imageId: z.string().uuid(),
      direction: z.enum(["up", "down"]),
    })
    .strict(),
  z
    .object({ action: z.literal("promote"), imageId: z.string().uuid() })
    .strict(),
  /** The whole arrangement at once — what drag-and-drop saves. */
  z
    .object({
      action: z.literal("order"),
      imageIds: z.array(z.string().uuid()).min(1).max(60),
    })
    .strict(),
  z
    .object({
      action: z.literal("alt"),
      imageId: z.string().uuid(),
      altText: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/images">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = mutateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();

    if (parsed.data.action === "remove") {
      await removeProductImage(user, parsed.data.imageId);
    } else if (parsed.data.action === "promote") {
      await makeProductImagePrimary(user, parsed.data.imageId);
    } else if (parsed.data.action === "order") {
      await setProductImageOrder(user, productId, parsed.data.imageIds);
    } else if (parsed.data.action === "alt") {
      await updateProductImageAltText(
        user,
        parsed.data.imageId,
        parsed.data.altText,
      );
    } else {
      await reorderProductImage(
        user,
        parsed.data.imageId,
        parsed.data.direction,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
