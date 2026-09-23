import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { listingKeywordMigration, suggestAliasesFromKeywords } from "@/lib/pkb";

/**
 * A listing's recorded search terms, and the one action that moves them into
 * the knowledge base (D-105).
 *
 * `POST` proposes each term as a *suggested* product alias and nothing more.
 * Approving one is a separate decision behind `search.manage`, and the search
 * terms themselves are never deleted — the column is retained on purpose.
 */
export async function GET(request: Request, context: RouteContext<"/api/admin/products/[productId]/keyword-aliases">) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That listing was not found." }, { status: 404 });
  }

  try {
    return NextResponse.json(await listingKeywordMigration(await getCurrentUser(), productId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/admin/products/[productId]/keyword-aliases">) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That listing was not found." }, { status: 404 });
  }

  // The action takes no arguments: which terms it proposes is decided by what
  // is recorded on the listing, not by what a request asks for.
  const body = await request.json().catch(() => null);
  if (body !== null && Object.keys(body as object).length > 0) {
    return NextResponse.json({ error: "This request takes no fields." }, { status: 400 });
  }

  try {
    return NextResponse.json(await suggestAliasesFromKeywords(await getCurrentUser(), productId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
