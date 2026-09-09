import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  advanceOrder,
  refundOrder,
  requestCancellation,
  resolveCancellationRequest,
  takeBalancePayment,
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
  /*
   * A shopper asking to cancel. It records a request rather than cancelling —
   * staff make the final decision (DECISIONS.md D-014) — so it carries the
   * customer's reason in their own words.
   */
  z
    .object({
      action: z.literal("cancel"),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  /* Staff answering that request. */
  z
    .object({
      action: z.literal("resolve_cancellation"),
      decision: z.enum(["approve", "decline"]),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
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
      /*
       * Optional, and in paisa. Present means refund part of the order and
       * leave it where it is; absent means refund everything still refundable
       * and close the order. How much is left is decided on the server from
       * the payment rows — this can only ask for less than that, never more.
       */
      amountBdt: z.number().int().positive().max(100_000_000).optional(),
      /* The bKash or bank transaction staff made by hand, for the books. */
      reference: z.string().trim().max(120).optional(),
    })
    .strict(),
  /*
   * Deliberately carries no amount. The balance is whatever the order still
   * owes, computed from its own payment rows on the server — a request that
   * could name a figure would be a request that could name the wrong one
   * (CLAUDE.md section 7).
   */
  z.object({ action: z.literal("take_balance") }).strict(),
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
          result: await requestCancellation(
            user,
            orderId,
            parsed.data.reason ?? "",
          ),
        });
      case "resolve_cancellation":
        return NextResponse.json({
          result: await resolveCancellationRequest(
            user,
            orderId,
            parsed.data.decision,
            parsed.data.note,
          ),
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
          result: await refundOrder(user, orderId, parsed.data.reason, {
            amountBdt: parsed.data.amountBdt,
            reference: parsed.data.reference,
          }),
        });
      case "take_balance":
        return NextResponse.json({
          result: await takeBalancePayment(user, orderId),
        });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
