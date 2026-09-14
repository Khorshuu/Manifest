import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getEnv } from "@/lib/env";
import { confirmPayment } from "@/lib/orders";

const schema = z.object({ providerRef: z.string().min(1) }).strict();

/**
 * Development stand-in for a gateway's webhook, and nothing more.
 *
 * It confirms a payment by reference without any proof that money moved, so
 * it must never be reachable where real orders live. In production it answers
 * 404 whatever the configuration; elsewhere it only works while the mock
 * provider is selected. Real gateways confirm through the signed webhook at
 * /api/webhooks/payments/[provider].
 */
function mockConfirmationAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return getEnv().PAYMENT_PROVIDER === "mock";
}

export async function POST(request: Request) {
  if (!mockConfirmationAllowed()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

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
