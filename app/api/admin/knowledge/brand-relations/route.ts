import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { decideBrandRelation, suggestBrandRelation } from "@/lib/pkb/trust";

/**
 * Who makes what: a brand's manufacturer, parent or former name. These carry
 * trust across brands, so they are approved rather than assumed (A-9).
 */
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("suggest"),
    brandId: z.string().uuid(),
    relatedBrandId: z.string().uuid(),
    kind: z.enum(["manufactured_by", "subsidiary_of", "formerly_known_as"]),
    note: z.string().max(500).nullish(),
  }),
  z.object({ action: z.literal("decide"), relationId: z.string().uuid(), decision: z.enum(["approved", "rejected"]) }),
]);

export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const actor = await getCurrentUser();
    const input = parsed.data;
    if (input.action === "decide") {
      return NextResponse.json(await decideBrandRelation(actor, input.relationId, input.decision));
    }
    return NextResponse.json(
      await suggestBrandRelation(actor, {
        brandId: input.brandId,
        relatedBrandId: input.relatedBrandId,
        kind: input.kind,
        note: input.note ?? null,
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
