import type { NextConfig } from "next";

/**
 * Security headers, set once at the framework level rather than per route
 * (docs/SECURITY.md).
 *
 * The Content-Security-Policy is deliberately strict about where scripts and
 * connections may come from. `unsafe-inline` on styles is required by the
 * framework's inlined critical CSS; scripts do not get it in production.
 */
const isProduction = process.env.NODE_ENV === "production";

const scriptSrc = isProduction
  ? "'self' 'unsafe-inline'"
  : // The dev server evaluates modules for fast refresh.
    "'self' 'unsafe-inline' 'unsafe-eval'";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Only our own origin: no third-party beacons.
  `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
  "form-action 'self'",
  // Nothing may frame this site, which stops clickjacking a checkout.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No feature this site uses needs any of these.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // A version header tells an attacker what to look up.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
