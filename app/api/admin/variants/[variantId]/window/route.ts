import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { closePreorder, extendPreorder, openPreorder } from "@/lib/preorder";
import { preorderWindowSchema } from "@/lib/validation/preorder";

/**
 * Opening, extending and closing one variant's preorder window.
 *
 * Every rule that matters is enforced in `lib/preorder/lifecycle.ts` rather
 * than here — capacity may not drop below what is already reserved, and a
 * closing date may not be in the past — because those need the variant's own
 * row read inside the same transaction. This route validates the shape of the
 * request and nothing else, so a caller who skips the form gets the same
 * answers as one who uses it.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/variants/[variantId]/window">,
) {
  const { variantId } = await context.params;

  if (!z.string().uuid().safeParse(variantId).success) {
    return NextResponse.json(
      { error: "That variant was not found." },
      { status: 400 },
    );
  }

  const parsed = preorderWindowSchema.safeParse(
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
    const input = parsed.data;

    const variant =
      input.action === "open"
        ? await openPreorder(user, variantId, {
            capacity: input.capacity,
            closesAt: input.closesAt ? new Date(input.closesAt) : null,
          })
        : input.action === "extend"
          ? await extendPreorder(user, variantId, new Date(input.closesAt))
          : await closePreorder(user, variantId);

    return NextResponse.json({
      variant: {
        id: variant.id,
        preorderCapacity: variant.preorderCapacity,
        preorderReserved: variant.preorderReserved,
        preorderClosesAt: variant.preorderClosesAt,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
