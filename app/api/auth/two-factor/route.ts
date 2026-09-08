import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import {
  invalidateSession,
  pendingSessionUserId,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  upgradePendingSession,
} from "@/lib/auth/session";
import { verifySecondFactor } from "@/lib/auth/two-factor";
import { consumeRateLimit } from "@/lib/rate-limit";

const bodySchema = z
  .object({ code: z.string().trim().min(1).max(64) })
  .strict();

const WINDOW_MS = 15 * 60 * 1000;

/** A six-digit code is guessable at scale, so the attempts are capped hard. */
const MAX_ATTEMPTS = 10;

const rateLimitDisabled =
  process.env.NODE_ENV !== "production" &&
  process.env.RATE_LIMIT_DISABLED === "1";

/**
 * The second step of signing in. It takes the pending session from the cookie
 * rather than an account identifier from the request, so nobody can offer
 * codes for an account they have not already passed the password for.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the code." }, { status: 400 });
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return NextResponse.json(
      { error: "Start again from the sign-in page." },
      { status: 401 },
    );
  }

  const userId = await pendingSessionUserId(token);

  if (!userId) {
    return NextResponse.json(
      { error: "That sign-in has expired. Start again." },
      { status: 401 },
    );
  }

  try {
    if (!rateLimitDisabled) {
      const headerList = await headers();
      const ip =
        headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

      // Capped per account and per address: brute-forcing six digits is only
      // hard if the attempts are limited.
      for (const key of [`2fa:user:${userId}`, `2fa:ip:${ip}`]) {
        const limit = await consumeRateLimit(key, MAX_ATTEMPTS, WINDOW_MS);

        if (!limit.allowed) {
          // The pending session is destroyed rather than left to be retried
          // later: a burnt sign-in attempt should not stay open.
          await invalidateSession(token);
          store.delete(SESSION_COOKIE_NAME);

          return NextResponse.json(
            { error: "Too many attempts. Sign in again." },
            {
              status: 429,
              headers: { "Retry-After": String(limit.retryAfterSeconds) },
            },
          );
        }
      }
    }

    const result = await verifySecondFactor(userId, parsed.data.code);

    if (!result.accepted) {
      return NextResponse.json(
        { error: "That code is not right." },
        { status: 401 },
      );
    }

    const upgraded = await upgradePendingSession(token);

    if (!upgraded) {
      return NextResponse.json(
        { error: "That sign-in has expired. Start again." },
        { status: 401 },
      );
    }

    store.set(SESSION_COOKIE_NAME, token, {
      ...sessionCookieOptions,
      expires: upgraded.expiresAt,
    });

    return NextResponse.json({
      ok: true,
      usedRecoveryCode: result.usedRecoveryCode,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
