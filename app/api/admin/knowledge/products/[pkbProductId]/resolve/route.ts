import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { db } from "@/db";
import { confirmIdentity, refreshResolution } from "@/lib/pkb/resolution";

/**
 * Product resolution: re-check the state, or confirm which product this is.
 * Confirming needs a note, and it is what unlocks factual enrichment (D-072).
 */
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({
    action: z.literal("confirm"),
    note: z.string().min(5).max(500),
    distinctFrom: z.array(z.string().uuid()).max(20).optional(),
  }).strict(),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/knowledge/products/[pkbProductId]/resolve">,
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
    if (parsed.data.action === "refresh") {
      // Reading the state is a staff action; the guard above is the check.
      return NextResponse.json(await db.transaction((tx) => refreshResolution(tx, pkbProductId)));
    }
    return NextResponse.json(
      await confirmIdentity(await getCurrentUser(), pkbProductId, {
        note: parsed.data.note,
        distinctFrom: parsed.data.distinctFrom,
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
