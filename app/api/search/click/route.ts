import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { logSearchClick } from "@/lib/search/analytics";
import { rememberSearchAttribution } from "@/lib/search/attribution";
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
  if (!allowRequest(`click:${visitor}`, getEnv().SEARCH_CLICK_LIMIT, 60_000)) {
    return new NextResponse(null, { status: 429 });
  }

  await logSearchClick({
    query: parsed.data.q,
    productId: parsed.data.productId,
    position: parsed.data.position,
    visitorHash: visitor,
  });

  // So that adding this product to a cart, and paying for it, can be counted
  // against the search that found it (D-093). Nothing about the shopper is
  // stored; the cookie names one search and one product and expires in half an
  // hour.
  await rememberSearchAttribution(parsed.data.q, parsed.data.productId);

  return new NextResponse(null, { status: 204 });
}
