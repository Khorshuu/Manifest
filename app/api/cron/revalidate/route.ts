import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { invalidateCatalog, isKnownCacheTag } from "@/lib/cache";
import { isAuthorisedScheduler } from "@/lib/cron-auth";

/**
 * Where the background worker hands over the cache tags its jobs invalidated
 * (D-133). The worker is not the web application and has no cache of its own;
 * a publish date it applied, or a listing it prepared, would otherwise wait
 * for the cached page's lifetime to lapse before a shopper saw it.
 *
 * Authenticated like the job trigger, with CRON_SECRET. It can only mark
 * cache entries stale, and only for tags this application itself uses: an
 * unknown tag refuses the whole request rather than being passed on.
 */

const bodySchema = z.object({ tags: z.array(z.string().max(64)).min(1).max(500) }).strict();

export async function POST(request: Request) {
  if (!isAuthorisedScheduler((await headers()).get("authorization"))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !parsed.data.tags.every(isKnownCacheTag)) {
    return NextResponse.json({ error: "Send the cache tags to invalidate." }, { status: 400 });
  }

  try {
    invalidateCatalog(parsed.data.tags);
    return NextResponse.json({ invalidated: new Set(parsed.data.tags).size });
  } catch (error) {
    return toErrorResponse(error);
  }
}
