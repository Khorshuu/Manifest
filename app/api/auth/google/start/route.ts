import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { safeNext } from "@/components/auth-shell";
import {
  buildAuthorizationUrl,
  googleConfig,
  googleRedirectUri,
} from "@/lib/auth/google";
import { siteUrl } from "@/lib/seo";

/**
 * Starts the Google sign-in. The state and the PKCE verifier are held in
 * short-lived http-only cookies, so the callback can prove that the response
 * it receives belongs to the request this browser made.
 */
export const dynamic = "force-dynamic";

/** Long enough to sign in with, short enough not to sit around. */
const HANDSHAKE_MAX_AGE_SECONDS = 10 * 60;

export async function GET(request: Request) {
  const config = googleConfig();
  // The button is shown even without credentials (D-050), so a visitor who
  // follows it lands on the sign-in page with a reason, not a 404.
  if (!config) {
    return NextResponse.redirect(new URL("/login?error=google-unavailable", siteUrl()));
  }

  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const store = await cookies();
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: HANDSHAKE_MAX_AGE_SECONDS,
  } as const;

  store.set("google_oauth_state", state, options);
  store.set("google_oauth_verifier", codeVerifier, options);
  store.set("google_oauth_next", next, options);

  return NextResponse.redirect(
    buildAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: googleRedirectUri(siteUrl()),
      state,
      codeChallenge,
    }),
  );
}
