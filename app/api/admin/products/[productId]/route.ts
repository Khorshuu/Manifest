import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { archiveProduct, restoreProduct, updateProduct } from "@/lib/catalog";
import { productInputSchema } from "@/lib/validation/catalog";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = productInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const product = await updateProduct(user, productId, parsed.data);
    return NextResponse.json({ product });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const lifecycleSchema = z
  .object({ action: z.enum(["archive", "restore"]) })
  .strict();

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[productId]">,
) {
  const { productId } = await context.params;

  if (!z.string().uuid().safeParse(productId).success) {
    return NextResponse.json(
      { error: "That product was not found." },
      { status: 400 },
    );
  }

  const parsed = lifecycleSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();

    // Archive, never delete: orders reference products.
    const result =
      parsed.data.action === "archive"
        ? await archiveProduct(user, productId)
        : await restoreProduct(user, productId);

    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
