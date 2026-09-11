import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  archiveProduct,
  deleteProduct,
  duplicateProduct,
  restoreProduct,
  unpublishProduct,
  updateProduct,
} from "@/lib/catalog";
import { productPatchSchema } from "@/lib/validation/catalog";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = productPatchSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const product = await updateProduct(user, productId, parsed.data);
    return NextResponse.json({ product });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const lifecycleSchema = z
  .object({ action: z.enum(["archive", "restore", "unpublish", "duplicate"]) })
  .strict();

/** Deletes a product nothing depends on; refuses one with history. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]">,
) {
  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 400 });
  }
  try {
    const result = await deleteProduct(await getCurrentUser(), productId);
    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = lifecycleSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();

    const action = parsed.data.action;
    const result =
      action === "archive"
        ? await archiveProduct(user, productId)
        : action === "restore"
          ? await restoreProduct(user, productId)
          : action === "unpublish"
            ? await unpublishProduct(user, productId)
            : await duplicateProduct(user, productId);

    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
