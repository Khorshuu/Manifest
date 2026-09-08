import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { authenticate, CredentialsError } from "@/lib/auth/accounts";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validation/auth";

/**
 * Per-account attempts are the meaningful limit: an office, campus, or mobile
 * carrier NAT puts many legitimate users behind one address, so the per-IP
 * ceiling is set well above the per-account one to avoid locking them out.
 */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Only ever honoured outside production, so end-to-end runs are not throttled
 * by a limit meant for real traffic.
 */
const rateLimitDisabled =
  process.env.NODE_ENV !== "production" &&
  process.env.RATE_LIMIT_DISABLED === "1";

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Check the email and password you entered." },
      { status: 400 },
    );
  }

  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  // Limited per IP and per account, so neither a single address nor a single
  // targeted account can be hammered.
  const env = getEnv();

  const limits = rateLimitDisabled
    ? []
    : ([
        [`login:ip:${ip}`, env.LOGIN_RATE_LIMIT_PER_IP],
        [`login:email:${parsed.data.email}`, env.LOGIN_RATE_LIMIT_PER_ACCOUNT],
      ] as const);

  for (const [key, max] of limits) {
    const limit = checkRateLimit(key, max, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
        },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
  }

  try {
    const { session, user } = await authenticate(parsed.data);
    const store = await cookies();
    store.set(SESSION_COOKIE_NAME, session.token, {
      ...sessionCookieOptions,
      expires: session.expiresAt,
    });
    return NextResponse.json({ user });
  } catch (error) {
    if (error instanceof CredentialsError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }
}
