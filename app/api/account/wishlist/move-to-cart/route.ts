import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { moveWishlistItemToCart } from "@/lib/account";
import { resolveCartId } from "@/lib/cart/session";
import { moveToCartSchema } from "@/lib/validation/account";

export async function POST(request: Request) {
  const parsed = moveToCartSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the item." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "You need to sign in to do that." },
        { status: 401 },
      );
    }
    await moveWishlistItemToCart(user, await resolveCartId(), parsed.data.variantId);
    return NextResponse.json({ moved: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
