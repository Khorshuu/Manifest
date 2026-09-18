import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { suggestAlias } from "@/lib/pkb/aliases";
import { aliasSuggestionSchema } from "@/lib/validation/search";

/**
 * Records a search someone ran as another name for a brand, product or family
 * (D-094).
 *
 * The result is a *suggested* alias and nothing more. It changes no search
 * until somebody with the right permission approves it in the knowledge base —
 * two deliberate steps, because a customer's words becoming search vocabulary
 * on their own would let anyone teach the shop what their words mean.
 *
 * The permission is checked inside `suggestAlias`, not here: hiding the button
 * is not access control (CLAUDE.md section 7).
 */
export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = aliasSuggestionSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the alias." },
      { status: 400 },
    );
  }

  try {
    const alias = await suggestAlias(await getCurrentUser(), {
      target: { kind: parsed.data.targetKind, id: parsed.data.targetId },
      alias: parsed.data.alias,
      aliasKind: parsed.data.aliasKind,
      evidenceNote:
        parsed.data.evidenceNote ??
        "Suggested from a search that found nothing.",
    });
    return NextResponse.json({ alias }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
