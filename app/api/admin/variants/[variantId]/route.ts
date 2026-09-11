import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { removeVariant, restoreVariant, setVariantImage, updateVariant } from "@/lib/catalog";
import { variantUpdateSchema } from "@/lib/validation/variants";

/** One variant's price, capacity, window and payment terms. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/variants/[variantId]">,
) {
  const { variantId } = await context.params;

  if (!z.string().uuid().safeParse(variantId).success) {
    return NextResponse.json(
      { error: "That variant was not found." },
      { status: 400 },
    );
  }

  const parsed = variantUpdateSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details." },
      { status: 400 },
    );
  }

  try {
    // Capacity below what is already reserved is refused inside updateVariant,
    // which is where the reserved count can be read under the same transaction.
    const user = await getCurrentUser();
    const variant = await updateVariant(user, variantId, parsed.data);

    return NextResponse.json({
      variant: { id: variant.id, priceBdt: variant.priceBdt },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Deletes a variant nothing has referenced, or archives one with history —
 * the response says which, so the screen can tell staff.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/variants/[variantId]">,
) {
  const { variantId } = await context.params;
  if (!z.string().uuid().safeParse(variantId).success) {
    return NextResponse.json({ error: "That variant was not found." }, { status: 400 });
  }
  try {
    const result = await removeVariant(await getCurrentUser(), variantId);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Restores an archived variant, or sets / clears its own photograph. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/variants/[variantId]">,
) {
  const { variantId } = await context.params;
  const parsed = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("restore") }).strict(),
      z.object({ action: z.literal("image"), imageId: z.string().uuid().nullable() }).strict(),
    ])
    .safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(variantId).success || !parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }
  try {
    const user = await getCurrentUser();
    if (parsed.data.action === "image") await setVariantImage(user, variantId, parsed.data.imageId);
    else await restoreVariant(user, variantId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
