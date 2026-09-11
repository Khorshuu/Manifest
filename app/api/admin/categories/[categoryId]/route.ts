import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteCategory, updateCategory } from "@/lib/catalog";
import { toErrorResponse } from "@/lib/api-error";
import { categoryInputSchema } from "@/lib/validation/catalog";

/**
 * Renaming, re-parenting and removing one category. Permission, the cycle
 * check and the "only while nothing depends on it" rule all live in
 * `lib/catalog/categories.ts`, so this route adds nothing but the shape check.
 */
export async function PATCH(
  request: Request,
  { params }: RouteContext<"/api/admin/categories/[categoryId]">,
) {
  const { categoryId } = await params;
  const parsed = categoryInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const category = await updateCategory(user, categoryId, parsed.data);
    return NextResponse.json({ category });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext<"/api/admin/categories/[categoryId]">,
) {
  const { categoryId } = await params;

  try {
    const user = await getCurrentUser();
    await deleteCategory(user, categoryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
