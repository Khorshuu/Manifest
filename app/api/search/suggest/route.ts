import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { cleanQuery } from "@/lib/search/normalize";
import { suggest } from "@/lib/search/suggest";
import { allowRequest } from "@/lib/search/throttle";
import { currentVisitorHash } from "@/lib/search/visitor";

/**
 * Autosuggest. Public, like the storefront it serves: labels, links, a
 * photograph and the price a shopper would see on the product card anyway.
 * Never a stock level, never a sourcing cost, and never anything that is not
 * public (lib/search/suggest.ts).
 */
export async function GET(request: Request) {
  const term = new URL(request.url).searchParams.get("q") ?? "";

  // Two characters is the floor: one character matches most of the catalogue
  // and makes the answer worthless to the shopper and expensive to produce.
  if (cleanQuery(term).length < 2) {
    return NextResponse.json({ suggestions: [], correctedQuery: null });
  }

  // Forty a ten-second window is far beyond any typist with a debounced box,
  // and well short of a script walking the catalogue a prefix at a time.
  const visitor = await currentVisitorHash();
  if (!allowRequest(`suggest:${visitor}`, 40, 10_000)) {
    return NextResponse.json(
      { error: "Too many suggestions at once. Try again in a moment." },
      { status: 429, headers: { "retry-after": "10" } },
    );
  }

  try {
    const result = await suggest(term);
    return NextResponse.json(result, {
      // Short and private: suggestions follow the catalogue, and the catalogue
      // moves. A product unpublished now stops being suggested within 30s.
      headers: { "cache-control": "private, max-age=30" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
