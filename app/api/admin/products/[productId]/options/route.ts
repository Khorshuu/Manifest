import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { createProductOption } from "@/lib/catalog";

const optionSchema = z
  .object({
    name: z.string().trim().min(1, "Name the option — Color, Size, Capacity.").max(60),
    values: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  })
  .strict();

/** Adds an option (a variant group) that belongs to this product only. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/options">,
) {
  const { productId } = await context.params;
  const parsed = optionSchema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(productId).success || !parsed.success) {
    return NextResponse.json(
      { error: parsed.success ? "That product was not found." : parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  try {
    const option = await createProductOption(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json({ option }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
