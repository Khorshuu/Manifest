import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { removeProductOptionValue } from "@/lib/catalog";

/**
 * Removes a value from a product's option, with that product's variants that
 * carry it (archived where they were ordered). No other product is affected.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/attributes/values/[valueId]">,
) {
  const { valueId } = await context.params;
  if (!z.string().uuid().safeParse(valueId).success) {
    return NextResponse.json({ error: "That value was not found." }, { status: 400 });
  }
  try {
    const result = await removeProductOptionValue(await getCurrentUser(), valueId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
