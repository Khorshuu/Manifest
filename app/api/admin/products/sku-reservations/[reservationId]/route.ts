import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { releaseSkuReservation } from "@/lib/catalog/sku";

/**
 * Releases the SKU an abandoned Add Product form was holding. Only its own
 * holder can release it, and a SKU already made permanent is never released.
 */
export async function DELETE(
  _request: Request,
  { params }: RouteContext<"/api/admin/products/sku-reservations/[reservationId]">,
) {
  const { reservationId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const released = await releaseSkuReservation(user, reservationId);
    return NextResponse.json({ released });
  } catch (error) {
    return toErrorResponse(error);
  }
}
