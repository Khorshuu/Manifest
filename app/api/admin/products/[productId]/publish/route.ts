import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { getReadinessSummary, publishProduct } from "@/lib/catalog";

const publishSchema = z
  .object({
    status: z.enum([
      "in_stock",
      "preorder_open",
      "preorder_closed",
      "coming_soon",
      "scheduled",
    ]),
  })
  .strict();

/** The readiness of a product, as the wizard shows it. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/admin/products/[productId]/publish">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getReadinessSummary(user, productId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]/publish">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = publishSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    // publishProduct re-runs the readiness checks itself; a stale wizard page
    // cannot talk it into publishing something unfinished.
    const user = await getCurrentUser();
    const product = await publishProduct(user, productId, parsed.data.status);
    return NextResponse.json({ product });
  } catch (error) {
    return toErrorResponse(error);
  }
}
