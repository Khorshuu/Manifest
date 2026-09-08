import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  advanceOrder,
  cancelOwnOrder,
  refundOrder,
} from "@/lib/orders";

const ORDER_STATUSES = [
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "refunded",
] as const;

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }).strict(),
  z
    .object({
      action: z.literal("advance"),
      status: z.enum(ORDER_STATUSES),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("refund"),
      reason: z.string().trim().min(1, "Give a reason for the refund.").max(500),
    })
    .strict(),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/orders/[orderId]">,
) {
  const { orderId } = await context.params;

  // A malformed id is a bad request, not a server error.
  if (!z.string().uuid().safeParse(orderId).success) {
    return NextResponse.json({ error: "That order was not found." }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the request." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();

    // Each branch re-checks authorization inside lib/, not only here.
    switch (parsed.data.action) {
      case "cancel":
        return NextResponse.json({
          result: await cancelOwnOrder(user, orderId),
        });
      case "advance":
        return NextResponse.json({
          result: await advanceOrder(
            user,
            orderId,
            parsed.data.status,
            parsed.data.note,
          ),
        });
      case "refund":
        return NextResponse.json({
          result: await refundOrder(user, orderId, parsed.data.reason),
        });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
