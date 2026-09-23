import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { decideLabelMapping, retireLabelMapping } from "@/lib/pkb/mappings";

/**
 * The reviewed mapping workflow for labels no attribute names (A-8). A
 * decision is remembered and the listings it touches are re-synced, so the
 * values are placed by the normal pipeline rather than edited by hand.
 */
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("map"),
    label: z.string().min(1).max(200),
    context: z.enum(["spec_table", "measurements", "variant_option", "source_document", "any"]),
    familyId: z.string().uuid().nullish(),
    definitionId: z.string().uuid(),
    note: z.string().max(500).nullish(),
  }).strict(),
  z.object({
    action: z.literal("ignore"),
    label: z.string().min(1).max(200),
    context: z.enum(["spec_table", "measurements", "variant_option", "source_document", "any"]),
    familyId: z.string().uuid().nullish(),
    note: z.string().max(500).nullish(),
  }).strict(),
  z.object({ action: z.literal("retire"), mappingId: z.string().uuid() }).strict(),
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
    if (input.action === "retire") {
      return NextResponse.json(await retireLabelMapping(actor, input.mappingId));
    }
    return NextResponse.json(
      await decideLabelMapping(actor, {
        label: input.label,
        context: input.context,
        familyId: input.familyId ?? null,
        action: input.action === "map" ? "map" : "ignore",
        definitionId: input.action === "map" ? input.definitionId : null,
        note: input.note ?? null,
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
