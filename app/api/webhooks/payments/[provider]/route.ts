import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { handlePaymentWebhook } from "@/lib/payments/webhooks";
import { timed } from "@/lib/observability/log";

/**
 * Payment provider webhooks.
 *
 * Unauthenticated by session, because a gateway is not a person: the proof is
 * the provider's signature over the raw body, checked before anything else
 * (lib/payments/webhooks.ts). The body is read as text, never re-serialised,
 * because a signature covers exact bytes.
 */

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  try {
    const outcome = await timed(
      "payments.webhook",
      { provider, bytes: Buffer.byteLength(rawBody) },
      () => handlePaymentWebhook(provider, rawBody, request.headers),
      (result) => ({ result: result.result }),
    );
    return NextResponse.json({ received: true, outcome: outcome.result }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
