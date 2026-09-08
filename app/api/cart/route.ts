import { NextResponse } from "next/server";
import {
  addToCart,
  countCartItems,
  getCartView,
  removeCartItem,
  updateCartItem,
} from "@/lib/cart";
import { resolveCartId } from "@/lib/cart/session";
import { toErrorResponse } from "@/lib/api-error";
import {
  addToCartSchema,
  updateCartItemSchema,
} from "@/lib/validation/cart";

export async function GET() {
  const cartId = await resolveCartId();
  return NextResponse.json({ cart: await getCartView(cartId) });
}

export async function POST(request: Request) {
  const parsed = addToCartSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Check the item and quantity." },
      { status: 400 },
    );
  }

  try {
    const cartId = await resolveCartId();
    await addToCart(cartId, parsed.data.variantId, parsed.data.quantity);
    return NextResponse.json({ count: await countCartItems(cartId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = updateCartItemSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the quantity." }, { status: 400 });
  }

  try {
    const cartId = await resolveCartId();

    if (parsed.data.quantity === 0) {
      await removeCartItem(cartId, parsed.data.itemId);
    } else {
      await updateCartItem(cartId, parsed.data.itemId, parsed.data.quantity);
    }

    return NextResponse.json({ cart: await getCartView(cartId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
