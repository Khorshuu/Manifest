import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { fillWithSeoPulse } from "@/lib/seo-pulse";
import { refuseNonStaff } from "@/lib/auth/api-guard";

export const maxDuration = 120;

/**
 * One click: research the product (or reuse unchanged research) and fill the
 * fields that are empty with what SEO Pulse can say reliably. Nothing the
 * admin already wrote is replaced.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/seo-pulse/fill">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }
  try {
    const result = await fillWithSeoPulse(await getCurrentUser(), productId);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
