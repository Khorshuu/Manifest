import { NextResponse } from "next/server";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { findCartId } from "@/lib/cart/session";
import { toErrorResponse } from "@/lib/api-error";
import { placeOrder } from "@/lib/orders";
import { placeOrderSchema } from "@/lib/validation/cart";

export async function POST(request: Request) {
  const parsed = placeOrderSchema.safeParse(
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
    const cartId = await findCartId();

    if (!cartId) {
      return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
    }

    let shippingAddressId = parsed.data.shippingAddressId;

    // A guest supplies the address inline; it is stored against the account
    // when there is one, so it can be reused later.
    if (!shippingAddressId) {
      if (!parsed.data.address) {
        return NextResponse.json(
          { error: "Enter a delivery address." },
          { status: 400 },
        );
      }

      const [created] = await db
        .insert(addresses)
        .values({
          userId: user?.id ?? null,
          ...parsed.data.address,
          addressLine2: parsed.data.address.addressLine2 ?? null,
          postalCode: parsed.data.address.postalCode ?? null,
        })
        .returning({ id: addresses.id });

      shippingAddressId = created.id;
    }

    const placed = await placeOrder({
      cartId,
      userId: user?.id ?? null,
      guestEmail: parsed.data.email,
      guestPhone: parsed.data.phone ?? null,
      shippingAddressId,
      method: parsed.data.method,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return NextResponse.json({ order: placed });
  } catch (error) {
    return toErrorResponse(error);
  }
}
