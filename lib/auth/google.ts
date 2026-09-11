/**
 * Signing in with Google (DECISIONS.md D-042).
 *
 * The authorization-code flow with PKCE, written against Google's endpoints
 * directly rather than through an auth framework: the app already owns its
 * sessions, its roles and its second factor, and a framework would want to own
 * all three.
 *
 * Nothing here runs unless both credentials are configured. Without them
 * `googleConfig()` returns null, the button is not rendered, and the two
 * routes answer as if they did not exist.
 */

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type GoogleConfig = { clientId: string; clientSecret: string };

export function googleConfig(): GoogleConfig | null {
  // A host that lists the variable names it found hands blanks through, so an
  // empty string means "not configured" rather than "configured as empty".
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGoogleSignInEnabled(): boolean {
  return googleConfig() !== null;
}

/**
 * Where Google sends the browser back to. It must match a redirect URI
 * registered in the Google Cloud console exactly, so it is derived from the
 * site's own origin and never from a request header a client controls.
 */
export function googleRedirectUri(origin: string): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${origin.replace(/\/$/, "")}/api/auth/google/callback`;
}

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Asks for an account each time rather than silently reusing the last one,
  // which on a shared computer is the difference between signing in and
  // signing in as whoever used it before.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export type GoogleProfile = {
  subject: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
};

export class GoogleSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleSignInError";
  }
}

/**
 * Reads the claims out of an ID token.
 *
 * The signature is deliberately not checked here: this token is read only
 * from the body of a direct, server-to-server TLS response from Google's token
 * endpoint, which OpenID Connect Core §3.1.3.7 allows. The claims that decide
 * anything — issuer, audience, expiry — are still checked, so a token minted
 * for another application cannot be replayed at this one.
 */
export function readIdTokenClaims(
  idToken: string,
  clientId: string,
  now: number = Date.now(),
): GoogleProfile {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleSignInError("Malformed ID token.");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new GoogleSignInError("Unreadable ID token.");
  }

  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  if (!ISSUERS.includes(issuer)) {
    throw new GoogleSignInError("ID token was not issued by Google.");
  }

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) {
    throw new GoogleSignInError("ID token was issued for another application.");
  }

  const expiry = typeof claims.exp === "number" ? claims.exp : 0;
  if (expiry * 1000 <= now) throw new GoogleSignInError("ID token has expired.");

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!subject || !email) {
    throw new GoogleSignInError("ID token carried no account.");
  }

  return {
    subject,
    email: email.trim().toLowerCase(),
    // Google sends this as a boolean, but has historically sent the string
    // too; anything else counts as unverified.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    firstName: typeof claims.given_name === "string" ? claims.given_name : null,
    lastName: typeof claims.family_name === "string" ? claims.family_name : null,
  };
}

/** Exchanges the one-time code for the ID token, and reads it. */
export async function exchangeCodeForProfile(options: {
  config: GoogleConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleProfile> {
  const request = options.fetchImpl ?? fetch;

  const response = await request(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      code: options.code,
      code_verifier: options.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new GoogleSignInError("Google refused the sign-in attempt.");
  }

  const body = (await response.json().catch(() => null)) as {
    id_token?: string;
  } | null;

  if (!body?.id_token) {
    throw new GoogleSignInError("Google returned no ID token.");
  }

  return readIdTokenClaims(body.id_token, options.config.clientId);
}
