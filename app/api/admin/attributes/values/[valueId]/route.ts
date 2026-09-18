import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { removeProductOptionValue, renameProductOptionValue } from "@/lib/catalog";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/**
 * Removes a value from a product's option, with that product's variants that
 * carry it (archived where they were ordered). No other product is affected.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/attributes/values/[valueId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

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

const renameSchema = z.object({ value: z.string().trim().min(1).max(120) }).strict();

/**
 * Renames the value. The only path that may write `attribute_values.value`,
 * so the knowledge base learns of the rename from the person who made it
 * rather than from a trigger with no actor (risk R-8).
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/attributes/values/[valueId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { valueId } = await context.params;
  const parsed = renameSchema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(valueId).success) {
    return NextResponse.json({ error: "That value was not found." }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the value." }, { status: 400 });
  }
  try {
    const result = await renameProductOptionValue(await getCurrentUser(), valueId, parsed.data.value);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
