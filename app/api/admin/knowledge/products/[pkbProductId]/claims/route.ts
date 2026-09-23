import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { acceptClaims, correctClaim, rejectClaims, resolveConflict } from "@/lib/pkb/review";

/**
 * Deciding proposed values. Every action names the claims it acts on: there is
 * no "apply everything" (D-076).
 */
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    claimIds: z.array(z.string().uuid()).min(1).max(100),
    asVerified: z.boolean().optional(),
    overrideDecided: z.boolean().optional(),
    note: z.string().max(500).nullish(),
  }).strict(),
  z.object({
    action: z.literal("reject"),
    claimIds: z.array(z.string().uuid()).min(1).max(100),
    note: z.string().max(500).nullish(),
  }).strict(),
  z.object({
    action: z.literal("resolve_conflict"),
    claimId: z.string().uuid(),
    keepCurrent: z.boolean().optional(),
    overrideDecided: z.boolean().optional(),
    note: z.string().max(500).nullish(),
  }).strict(),
  z.object({
    action: z.literal("correct"),
    claimId: z.string().uuid(),
    raw: z.string().min(1).max(500),
    note: z.string().max(500).nullish(),
  }).strict(),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/knowledge/products/[pkbProductId]/claims">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { pkbProductId } = await context.params;
  if (!z.string().uuid().safeParse(pkbProductId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const actor = await getCurrentUser();
    const input = parsed.data;
    switch (input.action) {
      case "accept":
        return NextResponse.json(
          await acceptClaims(actor, {
            claimIds: input.claimIds,
            asVerified: input.asVerified,
            overrideDecided: input.overrideDecided,
            note: input.note ?? null,
          }),
        );
      case "reject":
        return NextResponse.json({ rejected: await rejectClaims(actor, input.claimIds, input.note ?? null) });
      case "resolve_conflict":
        return NextResponse.json(
          await resolveConflict(actor, {
            claimId: input.claimId,
            keepCurrent: input.keepCurrent,
            overrideDecided: input.overrideDecided,
            note: input.note ?? null,
          }),
        );
      case "correct":
        return NextResponse.json(await correctClaim(actor, input.claimId, input.raw, input.note ?? null));
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
