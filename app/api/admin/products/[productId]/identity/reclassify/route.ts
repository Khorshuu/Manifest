import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { reclassifyWeakIdentity } from "@/lib/catalog/identity-cleanup";

/**
 * Takes weak values out of a product's identity fields at a person's explicit
 * request (D-123). The service checks again which values are still weak and
 * that the product's version is established; the request only names fields.
 */
const schema = z
  .object({
    fields: z.array(z.enum(["modelName", "modelNumber", "manufacturerPartNumber"])).min(1).max(3),
  })
  .strict();

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/identity/reclassify">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }
  try {
    return NextResponse.json(await reclassifyWeakIdentity(await getCurrentUser(), productId, parsed.data.fields));
  } catch (error) {
    return toErrorResponse(error);
  }
}
