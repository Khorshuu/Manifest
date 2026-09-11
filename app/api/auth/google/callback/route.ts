import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { safeNext } from "@/components/auth-shell";
import { signInWithGoogle } from "@/lib/auth/accounts";
import {
  exchangeCodeForProfile,
  googleConfig,
  googleRedirectUri,
} from "@/lib/auth/google";
import {
  SESSION_COOKIE_NAME,
  safeTokenEquals,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

const HANDSHAKE_COOKIES = [
  "google_oauth_state",
  "google_oauth_verifier",
  "google_oauth_next",
] as const;

export async function GET(request: Request) {
  const config = googleConfig();
  if (!config) return new NextResponse("Not found", { status: 404 });

  const origin = siteUrl();
  const url = new URL(request.url);
  const store = await cookies();

  const state = store.get("google_oauth_state")?.value ?? "";
  const codeVerifier = store.get("google_oauth_verifier")?.value ?? "";
  const next = safeNext(store.get("google_oauth_next")?.value);

  // Whatever happens next, this handshake is spent.
  for (const name of HANDSHAKE_COOKIES) store.delete(name);

  const failure = (reason: string) =>
    NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(reason)}${
        next !== "/" ? `&next=${encodeURIComponent(next)}` : ""
      }`,
    );

  // The visitor pressed cancel, or Google declined.
  if (url.searchParams.get("error")) return failure("google-cancelled");

  const code = url.searchParams.get("code") ?? "";
  const returnedState = url.searchParams.get("state") ?? "";

  if (!code || !state || !codeVerifier) return failure("google-expired");
  if (!safeTokenEquals(state, returnedState)) return failure("google-state");

  try {
    const profile = await exchangeCodeForProfile({
      config,
      code,
      codeVerifier,
      redirectUri: googleRedirectUri(origin),
    });

    const { session, needsSecondFactor } = await signInWithGoogle(profile);

    // Google sign-in does not stand in for the second factor: the cookie set
    // here authenticates nothing until the code is proved.
    const destination = needsSecondFactor
      ? `${origin}/login?code=required${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`
      : `${origin}${next}`;

    const response = NextResponse.redirect(destination);
    response.cookies.set(SESSION_COOKIE_NAME, session.token, {
      ...sessionCookieOptions,
      expires: session.expiresAt,
    });

    return response;
  } catch {
    return failure("google-failed");
  }
}
