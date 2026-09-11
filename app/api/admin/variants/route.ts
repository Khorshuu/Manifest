import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { bulkUpdateVariants, generateVariants, setProductAttributes } from "@/lib/catalog";
import { toErrorResponse } from "@/lib/api-error";
import {
  bulkVariantUpdateSchema,
  generateVariantsSchema,
} from "@/lib/validation/variants";

/** Generates the missing combinations for a product. */
export async function POST(request: Request) {
  const parsed = generateVariantsSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    await setProductAttributes(user, parsed.data.productId, parsed.data.attributeIds);
    const result = await generateVariants(user, parsed.data.productId, {
      priceBdt: parsed.data.priceBdt,
      fulfillmentMode: parsed.data.fulfillmentMode,
      prune: parsed.data.prune,
    });
    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Applies one change across many variants. */
export async function PATCH(request: Request) {
  const parsed = bulkVariantUpdateSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const updated = await bulkUpdateVariants(
      user,
      parsed.data.variantIds,
      parsed.data.update,
    );
    return NextResponse.json({ updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}
