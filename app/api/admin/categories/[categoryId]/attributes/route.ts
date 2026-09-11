import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "@/lib/auth/authorize";
import {
  createCategoryAttribute,
  listCategoryAttributes,
  resolveCategoryAttributes,
} from "@/lib/catalog";
import { categoryAttributeInputSchema } from "@/lib/validation/catalog";

/**
 * The specifications a category asks its products for.
 *
 * `?inherited=1` returns what a product in this category is actually asked —
 * the category's own attributes plus everything defined on its ancestors —
 * which is what the product form renders.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/categories/[categoryId]/attributes">,
) {
  const { categoryId } = await context.params;

  if (!z.string().uuid().safeParse(categoryId).success) {
    return NextResponse.json(
      { error: "That category was not found." },
      { status: 400 },
    );
  }

  try {
    // Specification definitions are internal catalogue structure, so reading
    // them is staff-only like writing them.
    requireStaff(await getCurrentUser());

    const inherited = new URL(request.url).searchParams.get("inherited") === "1";

    return NextResponse.json({
      attributes: inherited
        ? await resolveCategoryAttributes(categoryId)
        : await listCategoryAttributes(categoryId),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/categories/[categoryId]/attributes">,
) {
  const { categoryId } = await context.params;

  if (!z.string().uuid().safeParse(categoryId).success) {
    return NextResponse.json(
      { error: "That category was not found." },
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
    const attribute = await createCategoryAttribute(
      user,
      categoryId,
      parsed.data,
    );
    return NextResponse.json({ attribute }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
