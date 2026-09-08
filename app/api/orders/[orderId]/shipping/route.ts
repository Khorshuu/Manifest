import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  addInternalNote,
  bookShipment,
  setTrackingReference,
} from "@/lib/orders";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("book") }).strict(),
  z
    .object({
      action: z.literal("set_tracking"),
      trackingReference: z
        .string()
        .trim()
        .min(1, "Enter a tracking reference.")
        .max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("note"),
      note: z.string().trim().min(1, "Enter a note.").max(2000),
    })
    .strict(),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/orders/[orderId]/shipping">,
) {
  const { orderId } = await context.params;

  if (!z.string().uuid().safeParse(orderId).success) {
    return NextResponse.json(
      { error: "That order was not found." },
      { status: 400 },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the request." },
      { status: 400 },
    );
  }

  try {
    // Every branch re-checks the staff role inside lib/, not only here.
    const user = await getCurrentUser();

    switch (parsed.data.action) {
      case "book":
        return NextResponse.json({ result: await bookShipment(user, orderId) });
      case "set_tracking":
        return NextResponse.json({
          result: await setTrackingReference(
            user,
            orderId,
            parsed.data.trackingReference,
          ),
        });
      case "note":
        return NextResponse.json({
          result: await addInternalNote(user, orderId, parsed.data.note),
        });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
