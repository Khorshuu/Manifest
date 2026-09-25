import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { regenerateWithSeoPulse, SeoPulseError } from "@/lib/seo-pulse";
import { seoPulseRegenerateSchema } from "@/lib/validation/seo-pulse";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/**
 * Replaces fields with SEO Pulse's latest wording, at staff's explicit request
 * (D-120). Wording a person wrote is replaced only with `replaceStaff`.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/seo-pulse/regenerate">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = seoPulseRegenerateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const result = await regenerateWithSeoPulse(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SeoPulseError && error.details) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    return toErrorResponse(error);
  }
}
