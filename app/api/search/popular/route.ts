import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { searchInspiration } from "@/lib/search/suggest";

/**
 * What the search box offers before anything is typed: searches enough
 * different people ran that found something. Empty until real traffic says
 * otherwise — nothing here is seeded or invented.
 */
export async function GET() {
  try {
    const inspiration = await searchInspiration();
    return NextResponse.json(inspiration, {
      // The same for everyone, and it changes slowly.
      headers: { "cache-control": "public, max-age=300" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
