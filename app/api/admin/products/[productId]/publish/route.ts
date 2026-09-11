import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  getReadinessSummary,
  inferLiveStatus,
  NotReadyError,
  publishProduct,
} from "@/lib/catalog";

const publishSchema = z
  .object({
    /** Omitted: preorder_open for a preorder listing, in_stock otherwise. */
    status: z
      .enum([
        "in_stock",
        "preorder_open",
        "preorder_closed",
        "coming_soon",
        "discontinued",
        "scheduled",
      ])
      .optional(),
  })
  .strict();

/** The readiness of a product, as the wizard and editor show it. */
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
    await request.json().catch(() => ({})),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    // publishProduct re-runs the readiness checks itself; a stale page cannot
    // talk it into publishing something unfinished.
    const user = await getCurrentUser();
    const status = parsed.data.status ?? (await inferLiveStatus(productId));
    const product = await publishProduct(user, productId, status);
    return NextResponse.json({ product });
  } catch (error) {
    if (error instanceof NotReadyError) {
      const count = error.checks.length || error.failures.length;
      return NextResponse.json(
        {
          error: `${count} thing${count === 1 ? " needs" : "s need"} attention before publishing.`,
          failures: error.checks.map((check) => ({
            id: check.id,
            label: check.label,
            hint: check.hint,
          })),
        },
        { status: 409 },
      );
    }
    return toErrorResponse(error);
  }
}
