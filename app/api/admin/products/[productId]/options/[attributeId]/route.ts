import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { removeProductOption, renameProductOption } from "@/lib/catalog";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/** Removes a variant group from this product, and the variants built on it. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/options/[attributeId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

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

const renameSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

/**
 * Renames the group. The only path that may write `attributes.name`: it
 * re-reads the knowledge base in the same transaction, so the rename is
 * attributed to this person and a decided value refuses it (risk R-8).
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/options/[attributeId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId, attributeId } = await context.params;
  const parsed = renameSchema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(productId).success || !z.string().uuid().safeParse(attributeId).success) {
    return NextResponse.json({ error: "That option was not found." }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the name." }, { status: 400 });
  }
  try {
    const result = await renameProductOption(await getCurrentUser(), productId, attributeId, parsed.data.name);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
