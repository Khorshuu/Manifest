import { NextResponse, type NextRequest } from "next/server";

/**
 * Work done on a request before anything renders (docs/SECURITY.md).
 *
 * Three jobs, all decided from the request alone — a proxy should not reach
 * the database or import application modules, so each check here is the
 * outer layer, never the only one:
 *
 * 1. Cross-site mutations are refused. A state-changing API request (anything
 *    but GET, HEAD or OPTIONS) whose Origin is another site, or that the
 *    browser labels cross-site, gets 403. The session cookie is SameSite=Lax,
 *    which already keeps it off most cross-site requests; this does not rely on
 *    that alone. Payment webhooks and the scheduler are exempt: they carry no
 *    cookie and prove themselves with a signature or a shared secret.
 * 2. Pages get a Content-Security-Policy with a fresh nonce, so scripts run
 *    only if Next.js rendered them for this response — no 'unsafe-inline'.
 * 3. A signed-out visitor to the account or admin areas gets a real 307 to
 *    sign in. Those pages check the session themselves, and that check is the
 *    one that counts; this only answers the common case (no session cookie at
 *    all) before a streamed page could start with a 200.
 */

/** Repeated from lib/auth/session.ts: the proxy does not import application modules. */
const SESSION_COOKIE_NAME = "session";

/** Where Vercel Blob serves public files from (lib/providers/media/blob.ts). */
const BLOB_HOST = "https://*.public.blob.vercel-storage.com";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Authenticated by signature or secret, and called by servers, not browsers. */
const MACHINE_ENDPOINTS = ["/api/webhooks/", "/api/cron/"];

const SIGNED_IN_AREAS = ["/admin", "/account"];

export function isCrossSiteMutation(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/")) return false;
  if (SAFE_METHODS.has(request.method)) return false;
  if (MACHINE_ENDPOINTS.some((prefix) => pathname.startsWith(prefix))) return false;

  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  }
  // No Origin: a browser still says where the request came from.
  return request.headers.get("sec-fetch-site") === "cross-site";
}

export function contentSecurityPolicy(nonce: string, production = process.env.NODE_ENV === "production"): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets a nonced script load the chunks it needs; 'self'
    // is ignored by browsers that understand it and kept for those that do not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    // Style attributes are part of the design (positions, focal points), and a
    // nonce cannot cover an attribute; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${BLOB_HOST}`,
    "font-src 'self' data:",
    `connect-src 'self'${production ? "" : " ws: wss:"}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The id every log line for this request carries (lib/observability/log.ts),
 * returned to the caller in x-request-id so a report can be matched to logs.
 * An id from the hosting layer is kept when it looks like one.
 */
function requestIdFor(request: NextRequest): string {
  const incoming = request.headers.get("x-request-id") ?? request.headers.get("x-vercel-id");
  return incoming && /^[A-Za-z0-9:_.-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = requestIdFor(request);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  if (isCrossSiteMutation(request)) {
    const refused = NextResponse.json({ error: "Cross-site requests are not accepted." }, { status: 403 });
    refused.headers.set("x-request-id", requestId);
    return refused;
  }

  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-request-id", requestId);
    return response;
  }

  const inSignedInArea = SIGNED_IN_AREAS.some((area) => pathname === area || pathname.startsWith(`${area}/`));
  if (inSignedInArea && !request.cookies.has(SESSION_COOKIE_NAME)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login, 307);
  }

  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the nonce from this request header and puts it on every
  // script it renders.
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    // Everything but built assets, optimised images, uploaded files and the favicon.
    "/((?!_next/static|_next/image|uploads/|favicon.ico).*)",
  ],
};
