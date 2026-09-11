import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { deleteSynonym, updateSynonym } from "@/lib/search/synonyms";
import { synonymInputSchema } from "@/lib/validation/search";

function badId() {
  return NextResponse.json(
    { error: "That synonym was not found." },
    { status: 400 },
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/search/synonyms/[synonymId]">,
) {
  const { synonymId } = await context.params;
  if (!z.string().uuid().safeParse(synonymId).success) return badId();

  const parsed = synonymInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the synonym." },
      { status: 400 },
    );
  }

  try {
    const synonym = await updateSynonym(
      await getCurrentUser(),
      synonymId,
      parsed.data,
    );
    return NextResponse.json({ synonym });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/search/synonyms/[synonymId]">,
) {
  const { synonymId } = await context.params;
  if (!z.string().uuid().safeParse(synonymId).success) return badId();

  try {
    await deleteSynonym(await getCurrentUser(), synonymId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
