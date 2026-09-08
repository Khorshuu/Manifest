import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createCategory } from "@/lib/catalog";
import { toErrorResponse } from "@/lib/api-error";
import { categoryInputSchema } from "@/lib/validation/catalog";

export async function POST(request: Request) {
  const parsed = categoryInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const category = await createCategory(user, parsed.data);
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
