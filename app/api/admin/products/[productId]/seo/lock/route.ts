import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { SEO_FIELDS } from "@/db/schema";
import { setFieldLock } from "@/lib/seo/fields";

/**
 * Locking an SEO field. A locked field is never changed by SEO Pulse, and an
 * apply that names it is refused rather than quietly skipped (D-077).
 */
const schema = z.object({
  field: z.enum(SEO_FIELDS),
  lock: z.boolean(),
  note: z.string().max(500).nullish(),
}).strict();

export async function POST(request: Request, context: RouteContext<"/api/admin/products/[productId]/seo/lock">) {
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
    const result = await setFieldLock(
      await getCurrentUser(),
      productId,
      parsed.data.field,
      parsed.data.lock,
      parsed.data.note ?? null,
    );
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
