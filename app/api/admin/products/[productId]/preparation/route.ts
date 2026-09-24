import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { getPreparation, startPreparation } from "@/lib/preparation";
import { preparationStartSchema } from "@/lib/validation/preparation";

/**
 * Product preparation for one product (D-112).
 *
 * Starting it records a run and returns immediately: the work happens in
 * background jobs, because research retrieves pages over the network and
 * review waits for a person. The caller polls GET, or comes back tomorrow.
 *
 * `catalog.manage` throughout — preparing a product is a catalogue action. The
 * decisions preparation stops for are taken on their own screens, under their
 * own permissions: confirming an identity and accepting a claim ask for
 * `catalog.manage`, and approving a source domain or a verification policy
 * asks for `knowledge.manage`. None of that is relaxed by going through here.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/preparation">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  try {
    const run = await getPreparation(await getCurrentUser(), productId);
    return NextResponse.json({ run });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/preparation">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = preparationStartSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const run = await startPreparation(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
