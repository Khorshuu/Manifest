import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import {
  cancelPreparation,
  continuePreparation,
  getPreparationRun,
  retryPreparation,
} from "@/lib/preparation";
import { preparationActionSchema } from "@/lib/validation/preparation";

/**
 * One preparation run: read it, retry it, cancel it, or give it what it asked
 * for and let it go on (D-112).
 *
 * `continue` is the one that matters for the future screen: a run stopped
 * because somebody has to decide something, and this is how the answer — or
 * the missing identity, or the manufacturer's page — reaches it. Each piece is
 * applied through its existing path, so nothing arrives at the catalogue or
 * the knowledge base without the checks it would have had anyway.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/preparation/[runId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId, runId } = await context.params;
  if (!z.string().uuid().safeParse(runId).success) {
    return NextResponse.json({ error: "That preparation run was not found." }, { status: 404 });
  }

  try {
    const run = await getPreparationRun(await getCurrentUser(), runId);
    if (!run || run.productId !== productId) {
      return NextResponse.json({ error: "That preparation run was not found." }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/preparation/[runId]">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId, runId } = await context.params;
  if (!z.string().uuid().safeParse(runId).success) {
    return NextResponse.json({ error: "That preparation run was not found." }, { status: 404 });
  }

  const parsed = preparationActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const actor = await getCurrentUser();
    const existing = await getPreparationRun(actor, runId);
    if (!existing || existing.productId !== productId) {
      return NextResponse.json({ error: "That preparation run was not found." }, { status: 404 });
    }

    const { action, ...supplied } = parsed.data;
    const run =
      action === "retry"
        ? await retryPreparation(actor, runId)
        : action === "cancel"
          ? await cancelPreparation(actor, runId)
          : await continuePreparation(actor, runId, supplied);
    return NextResponse.json({ run });
  } catch (error) {
    return toErrorResponse(error);
  }
}
