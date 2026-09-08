import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimitHits } from "@/db/schema";

/**
 * Fixed-window rate limiting for login and password-reset attempts, counted in
 * the database so every process shares one count.
 *
 * The previous implementation was a Map inside one Node process. That is a
 * real limit for a single long-lived server and no limit at all for the
 * deployment target: on a serverless host each instance counted separately and
 * every deploy reset the count, so an attacker only had to spread attempts
 * (docs/SECURITY.md).
 *
 * Windows are aligned to absolute time rather than to first use. Two processes
 * therefore agree on which window an attempt belongs to without coordinating,
 * which is the whole point of moving the count out of memory.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/** The window an instant falls in, aligned so every process agrees. */
export function windowStartFor(now: number, windowMs: number): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

/**
 * Hashed, so the table never holds an email address or an IP in the clear.
 * Nothing reads a key back — it is only ever compared — so a one-way hash
 * costs nothing.
 */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Records one attempt and says whether it is allowed.
 *
 * The insert and the increment are a single statement, so two requests racing
 * for the last attempt in a window cannot both be told yes.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowStart = windowStartFor(now, windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now) / 1000),
  );

  try {
    const rows = await db
      .insert(rateLimitHits)
      .values({ key: hashKey(key), windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitHits.key, rateLimitHits.windowStart],
        set: {
          count: sql`${rateLimitHits.count} + 1`,
          updatedAt: new Date(now),
        },
      })
      .returning({ count: rateLimitHits.count });

    const count = rows[0]?.count ?? 1;

    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: 0,
    };
  } catch (error) {
    // Fail open, deliberately. Sign-in needs the database anyway, so a database
    // that cannot count attempts is one that cannot check a password either —
    // refusing here would turn an outage into a lockout without protecting
    // anything.
    console.error("Rate limit check failed; allowing the attempt.", error);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/**
 * Deletes windows that have closed. Cheap, indexed, and safe to call from a
 * request path: a failure here must never fail the request that triggered it.
 */
export async function pruneRateLimits(
  olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<number> {
  try {
    const deleted = await db
      .delete(rateLimitHits)
      .where(lt(rateLimitHits.windowStart, olderThan))
      .returning({ key: rateLimitHits.key });

    return deleted.length;
  } catch (error) {
    console.error("Could not prune rate limit rows.", error);
    return 0;
  }
}
