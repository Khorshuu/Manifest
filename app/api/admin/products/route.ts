import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createProduct } from "@/lib/catalog";
import { toErrorResponse } from "@/lib/api-error";
import { productInputSchema } from "@/lib/validation/catalog";

export async function POST(request: Request) {
  const parsed = productInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    // Authorization is re-checked inside createProduct, not just here.
    const user = await getCurrentUser();
    const product = await createProduct(user, parsed.data);
    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
