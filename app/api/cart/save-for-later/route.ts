import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { saveCartItemForLater } from "@/lib/account";
import { findCartId } from "@/lib/cart/session";
import { saveForLaterSchema } from "@/lib/validation/account";

export async function POST(request: Request) {
  const parsed = saveForLaterSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the item." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to save items for later." },
        { status: 401 },
      );
    }
    const cartId = await findCartId();
    if (!cartId) {
      return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
    }
    await saveCartItemForLater(user, cartId, parsed.data.itemId);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
