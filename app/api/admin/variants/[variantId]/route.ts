import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { updateVariant } from "@/lib/catalog";
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
