import { NextResponse } from "next/server";
import { logSearchClick } from "@/lib/search/analytics";
import { allowRequest } from "@/lib/search/throttle";
import { currentVisitorHash } from "@/lib/search/visitor";
import { searchClickSchema } from "@/lib/validation/search";

/**
 * A shopper chose a search result. Sent with `navigator.sendBeacon` as the
 * page navigates away, so it is read as text and parsed here rather than
 * trusting a content type. It records a query and a product id — nothing about
 * who — and a forged one only ever adds a click to an analytics count.
 */
export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (text.length > 2_000) {
    return new NextResponse(null, { status: 413 });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const parsed = searchClickSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  const visitor = await currentVisitorHash();
  if (!allowRequest(`click:${visitor}`, 30, 60_000)) {
    return new NextResponse(null, { status: 429 });
  }

  await logSearchClick({
    query: parsed.data.q,
    productId: parsed.data.productId,
    position: parsed.data.position,
    visitorHash: visitor,
  });

  return new NextResponse(null, { status: 204 });
}
