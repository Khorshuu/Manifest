import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  deleteCategoryAttribute,
  updateCategoryAttribute,
} from "@/lib/catalog";
import { categoryAttributeInputSchema } from "@/lib/validation/catalog";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/category-attributes/[attributeId]">,
) {
  const { attributeId } = await context.params;

  if (!z.string().uuid().safeParse(attributeId).success) {
    return NextResponse.json(
      { error: "That specification was not found." },
      { status: 400 },
    );
  }

  const parsed = categoryAttributeInputSchema.safeParse(
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
    const attribute = await updateCategoryAttribute(
      user,
      attributeId,
      parsed.data,
    );
    return NextResponse.json({ attribute });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/category-attributes/[attributeId]">,
) {
  const { attributeId } = await context.params;

  if (!z.string().uuid().safeParse(attributeId).success) {
    return NextResponse.json(
      { error: "That specification was not found." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    await deleteCategoryAttribute(user, attributeId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
