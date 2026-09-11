import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { getSeoPulseOverview, runSeoPulse } from "@/lib/seo-pulse";
import { seoPulseRunSchema } from "@/lib/validation/seo-pulse";

/** A run waits on external providers and an AI model; allow it time. */
export const maxDuration = 120;

/** The product's SEO Pulse status, latest research and history. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/seo-pulse">,
) {
  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  try {
    const overview = await getSeoPulseOverview(await getCurrentUser(), productId);
    if (!overview) {
      return NextResponse.json({ error: "That product was not found." }, { status: 404 });
    }
    return NextResponse.json(overview);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Runs research — or returns matching recent research unless `fresh`. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/seo-pulse">,
) {
  const { productId } = await context.params;
  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = seoPulseRunSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const result = await runSeoPulse(await getCurrentUser(), productId, parsed.data);
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
