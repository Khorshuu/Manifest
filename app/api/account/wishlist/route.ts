import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { addToWishlist, removeFromWishlist } from "@/lib/account";
import { wishlistInputSchema } from "@/lib/validation/account";

async function parse(request: Request) {
  return wishlistInputSchema.safeParse(await request.json().catch(() => null));
}

export async function POST(request: Request) {
  const parsed = await parse(request);
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the item." }, { status: 400 });
  }

  try {
    await addToWishlist(await getCurrentUser(), parsed.data.variantId);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const parsed = await parse(request);
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the item." }, { status: 400 });
  }

  try {
    await removeFromWishlist(await getCurrentUser(), parsed.data.variantId);
    return NextResponse.json({ saved: false });
  } catch (error) {
    return toErrorResponse(error);
  }
}
