import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { requestEnrichment } from "@/lib/pkb/enrichment";

/**
 * Asks for an enrichment run. The retrieval itself happens in a job, so this
 * returns as soon as the run is recorded (D-074).
 */
const schema = z.object({
  urls: z.array(z.string().url().max(2000)).max(10).optional(),
  note: z.string().max(500).nullish(),
});

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/knowledge/products/[pkbProductId]/enrich">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { pkbProductId } = await context.params;
  if (!z.string().uuid().safeParse(pkbProductId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = schema.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const result = await requestEnrichment(await getCurrentUser(), {
      pkbProductId,
      urls: parsed.data.urls,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json(result, { status: result.status === "blocked" ? 409 : 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
