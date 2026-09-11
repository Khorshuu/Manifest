import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { createSynonym, listSynonyms } from "@/lib/search/synonyms";
import { synonymInputSchema } from "@/lib/validation/search";

export async function GET() {
  try {
    const synonyms = await listSynonyms(await getCurrentUser());
    return NextResponse.json({ synonyms });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
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
    const synonym = await createSynonym(await getCurrentUser(), parsed.data);
    return NextResponse.json({ synonym }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
