import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { reserveSku } from "@/lib/catalog/sku";

/**
 * Reserves a SKU for the Add Product form, or renews the one the form already
 * holds. The browser only ever sends back an id it was given; it cannot name
 * a SKU to claim. Permission and ownership are checked in lib/catalog/sku.ts.
 */
const bodySchema = z
  .object({ reservationId: z.string().uuid().nullable().optional() })
  .strict();

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const reservation = await reserveSku(user, {
      reservationId: parsed.data.reservationId ?? null,
    });
    return NextResponse.json({ reservation }, { status: reservation.renewed ? 200 : 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
