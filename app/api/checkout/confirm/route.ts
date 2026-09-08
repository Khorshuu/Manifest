import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { confirmPayment } from "@/lib/orders";

const schema = z.object({ providerRef: z.string().min(1) }).strict();

/**
 * Stands in for the gateway's webhook while the mock provider is in use.
 *
 * The real SSLCommerz webhook will verify a signature before reaching this
 * logic; the idempotency guarantee is the same either way.
 */
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "A payment reference is required." },
      { status: 400 },
    );
  }

  try {
    const result = await confirmPayment(parsed.data.providerRef);
    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
