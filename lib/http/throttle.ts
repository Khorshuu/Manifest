import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * Rate limits for public endpoints, counted in PostgreSQL so they hold across
 * every server instance (lib/rate-limit.ts).
 *
 * Limits are only switched off outside production, and only when
 * RATE_LIMIT_DISABLED is set — the development end-to-end server.
 */

const disabled = process.env.NODE_ENV !== "production" && process.env.RATE_LIMIT_DISABLED === "1";

/** The caller's address as the hosting layer reports it. */
export async function clientAddress(): Promise<string> {
  const list = await headers();
  return list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip") || "local";
}

/**
 * Counts one attempt against each key and returns a 429 response if any is
 * over its ceiling, or null to carry on. Keys are hashed before storage.
 */
export async function throttle(
  checks: readonly (readonly [key: string, max: number])[],
  windowMs: number,
  message = "Too many attempts. Try again later.",
): Promise<NextResponse | null> {
  if (disabled) return null;
  for (const [key, max] of checks) {
    const result = await consumeRateLimit(key, max, windowMs);
    if (!result.allowed) {
      return NextResponse.json(
        { error: `${message} Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
      );
    }
  }
  return null;
}

/** For a page rather than a route: whether the attempt is allowed. */
export async function allowAttempt(key: string, max: number, windowMs: number): Promise<boolean> {
  if (disabled) return true;
  return (await consumeRateLimit(key, max, windowMs)).allowed;
}
