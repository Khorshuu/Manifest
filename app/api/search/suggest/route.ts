import { NextResponse } from "next/server";
import { suggestSearch } from "@/lib/catalog";

/**
 * Autosuggest. Public, like the storefront it serves, and deliberately narrow:
 * it returns labels and links, never prices, stock, or anything that would let
 * this endpoint be used to enumerate the catalog faster than browsing it.
 */
export async function GET(request: Request) {
  const term = new URL(request.url).searchParams.get("q") ?? "";

  // Two characters is the floor: one character matches most of the catalog and
  // makes the query worthless to the shopper and expensive to the database.
  if (term.trim().length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const suggestions = await suggestSearch(term.slice(0, 100));

  return NextResponse.json(
    { suggestions },
    // Short and private: suggestions follow the catalog, and the catalog moves.
    { headers: { "cache-control": "private, max-age=30" } },
  );
}
