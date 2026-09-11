import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { addAttributeValue } from "@/lib/catalog";
import { attributeValueSchema } from "@/lib/validation/variants";

/** Adds a value — "Teal" — to an option. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/attributes/[attributeId]/values">,
) {
  const { attributeId } = await context.params;
  const parsed = attributeValueSchema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(attributeId).success || !parsed.success) {
    return NextResponse.json(
      { error: parsed.success ? "That option was not found." : parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  try {
    const value = await addAttributeValue(await getCurrentUser(), attributeId, parsed.data.value);
    return NextResponse.json({ value }, { status: 201 });
  } catch (error) {
    const text = `${error instanceof Error ? error.message : ""} ${
      error instanceof Error && error.cause ? String(error.cause) : ""
    }`;
    if (/duplicate key|unique/i.test(text)) {
      return NextResponse.json({ error: `“${parsed.data.value}” is already a value.` }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
