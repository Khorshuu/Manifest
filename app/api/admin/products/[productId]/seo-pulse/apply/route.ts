import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { applySeoPulse, SeoPulseError } from "@/lib/seo-pulse";
import { seoPulseApplySchema } from "@/lib/validation/seo-pulse";

/** Applies the recommendations staff reviewed, refusing silent overwrites. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/seo-pulse/apply">,
) {
  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = seoPulseApplySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the values." },
      { status: 400 },
    );
  }

  try {
    const result = await applySeoPulse(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    // The conflict list tells the editor which fields need an explicit Replace.
    if (error instanceof SeoPulseError && error.details) {
      return NextResponse.json(
        { error: error.message, ...error.details },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
