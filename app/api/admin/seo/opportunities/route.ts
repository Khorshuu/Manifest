import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { decideOpportunity } from "@/lib/search-console";

/**
 * Records what a person decided about an SEO opportunity: they acted on it,
 * dismissed it, or are watching it (D-097). The opportunity itself is still
 * recomputed from the measurements every time the screen loads — this stores
 * the decision, not the finding.
 */
const schema = z.object({
  opportunityKey: z.string().min(1).max(400),
  kind: z.string().min(1).max(60),
  entityType: z.enum(["product", "category", "site"]),
  productId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  decision: z.enum(["acted", "dismissed", "watching"]),
  note: z.string().max(500).nullish(),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullish(),
}).strict();

export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const result = await decideOpportunity(await getCurrentUser(), {
      ...parsed.data,
      note: parsed.data.note ?? null,
      evidence: parsed.data.evidence ?? null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
