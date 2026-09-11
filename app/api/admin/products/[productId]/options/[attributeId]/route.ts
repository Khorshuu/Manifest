import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { removeProductOption } from "@/lib/catalog";

/** Removes a variant group from this product, and the variants built on it. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/options/[attributeId]">,
) {
  const { productId, attributeId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success || !z.string().uuid().safeParse(attributeId).success) {
    return NextResponse.json({ error: "That option was not found." }, { status: 400 });
  }
  try {
    const result = await removeProductOption(await getCurrentUser(), productId, attributeId);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
