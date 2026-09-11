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
  // Not configured is not an error a visitor should see explained: the button
  // that reaches here is not rendered either.
  if (!config) return new NextResponse("Not found", { status: 404 });

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
