import { cacheLife, cacheTag } from "next/cache";
import { NextResponse } from "next/server";
import { CACHE_TAGS } from "@/lib/cache";
import { toErrorResponse } from "@/lib/api-error";
import { searchInspiration } from "@/lib/search/suggest";

/**
 * What the search box offers before anything is typed: searches enough
 * different people ran that found something. Empty until real traffic says
 * otherwise — nothing here is seeded or invented.
 */
/**
 * Cached for a few minutes: without a cached helper this handler reads no
 * request data, so it would be prerendered once at build and frozen.
 */
async function cachedInspiration() {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.searchInspiration);
  return searchInspiration();
}

export async function GET() {
  try {
    const inspiration = await cachedInspiration();
    return NextResponse.json(inspiration, {
      // The same for everyone, and it changes slowly.
      headers: { "cache-control": "public, max-age=300" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
