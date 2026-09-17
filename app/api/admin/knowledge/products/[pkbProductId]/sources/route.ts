import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { addProductSource, provideDocument } from "@/lib/pkb/enrichment";
import { proposeClaimFromEvidence } from "@/lib/pkb/review";

/**
 * Add Source: a page to read, a document a person holds, or a value with the
 * evidence they are reading it from. None of them writes a fact.
 */
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url().max(2000), note: z.string().max(500).nullish() }),
  z.object({
    kind: z.literal("document"),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(400_000),
    contentType: z.enum(["text/plain", "text/html", "application/json"]).optional(),
    url: z.string().url().max(2000).nullish(),
  }),
  z.object({
    kind: z.literal("value"),
    evidenceId: z.string().uuid(),
    definitionId: z.string().uuid(),
    raw: z.string().max(500).optional(),
    unit: z.string().max(40).nullish(),
    notApplicable: z.boolean().optional(),
    ordinal: z.number().int().min(0).max(50).optional(),
    pkbVariantId: z.string().uuid().nullish(),
  }),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/knowledge/products/[pkbProductId]/sources">,
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
    if (input.kind === "url") {
      return NextResponse.json(await addProductSource(actor, pkbProductId, { url: input.url, note: input.note ?? null }));
    }
    if (input.kind === "document") {
      return NextResponse.json(
        await provideDocument(actor, pkbProductId, {
          title: input.title,
          content: input.content,
          contentType: input.contentType,
          url: input.url ?? null,
        }),
      );
    }
    const claim = await proposeClaimFromEvidence(actor, {
      pkbProductId,
      pkbVariantId: input.pkbVariantId ?? null,
      evidenceId: input.evidenceId,
      target: "fact",
      definitionId: input.definitionId,
      raw: input.raw,
      unit: input.unit ?? null,
      notApplicable: input.notApplicable,
      ordinal: input.ordinal,
    });
    return NextResponse.json({ claimId: claim.id, status: claim.status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
