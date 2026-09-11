import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { addVariant } from "@/lib/catalog";
import { addVariantSchema } from "@/lib/validation/variants";

/** Adds one variant to a product by hand. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/variants">,
) {
  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = addVariantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const variant = await addVariant(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json({ variant }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
