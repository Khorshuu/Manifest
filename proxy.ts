import { NextResponse, type NextRequest } from "next/server";

/**
 * A real redirect to sign in for signed-out visitors to the account and admin
 * areas (PRODUCTION-READINESS 18.1).
 *
 * Those pages check the session themselves, and that check is the one that
 * counts. But they stream, so by the time a page decides to redirect the
 * response has started: a visitor without JavaScript, a crawler or a security
 * scanner received "200" and a page with nothing on it. This answers the
 * common case — no session cookie at all — with a 307 before anything renders.
 *
 * It only looks for the cookie, because a proxy should not reach the database;
 * a cookie that is expired, forged or belongs to a customer still reaches the
 * page, which refuses it. The cookie name is repeated from lib/auth/session.ts
 * for the same reason: the proxy does not import application modules.
 */
const SESSION_COOKIE_NAME = "session";

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE_NAME)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login, 307);
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/account", "/account/:path*"],
};
