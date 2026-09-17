import type { NextConfig } from "next";

/**
 * Security headers, set once at the framework level rather than per route
 * (docs/SECURITY.md).
 *
 * Pages get their Content-Security-Policy from proxy.ts, with a fresh nonce
 * per response and no 'unsafe-inline' for scripts. The static policy below
 * is for everything the proxy does not render: API responses, built assets,
 * uploaded files. It allows no scripts at all.
 */
const isProduction = process.env.NODE_ENV === "production";

/** Where Vercel Blob serves public files from (lib/providers/media/blob.ts). */
const BLOB_HOST = "https://*.public.blob.vercel-storage.com";

const contentSecurityPolicy = [
  "default-src 'none'",
  `img-src 'self' data: blob: ${BLOB_HOST}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Nothing may frame this site, which stops clickjacking a checkout.
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const staticPolicyHeader = { key: "Content-Security-Policy", value: contentSecurityPolicy };

const otherSecurityHeaders = [
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
  /*
   * Cache Components (DECISIONS.md D-054): data is dynamic unless a function
   * opts into "use cache", and routes prerender a static shell with per-request
   * parts streamed in. Enabled route by route behind `instant = false`.
   */
  cacheComponents: true,
  // A version header tells an attacker what to look up.
  poweredByHeader: false,
  /*
   * The development route indicator is off.
   *
   * It floats in the bottom-left corner of every page, which is where this
   * shop puts things a shopper has to be able to press on a phone — the buy
   * bar, and the footer of the filter drawer. It was intercepting those
   * presses, in the browser and in the end-to-end suite alike, so a real
   * control was unreachable in development for the sake of a development
   * badge. Compile and runtime errors are still surfaced without it.
   */
  devIndicators: false,
  /*
   * Phones on the same Wi-Fi, in development only.
   *
   * The dev server refuses its own JavaScript to any origin but localhost, so a
   * phone opening http://192.168.x.x:3000 got the server-rendered page with
   * nothing behind it: the category menu, the search, every button inert. The
   * owner reviews on a phone, so the LAN address is allowed. Extra hosts can be
   * added with DEV_ORIGINS (comma-separated). Production ignores this setting.
   */
  allowedDevOrigins: [
    "192.168.1.107",
    ...(process.env.DEV_ORIGINS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  ],
  images: {
    // next/image refuses a host it was not told about, and product photography
    // lives in Vercel Blob once MEDIA_PROVIDER is 'blob'.
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
  async headers() {
    return [
      { source: "/:path*", headers: otherSecurityHeaders },
      // Pages carry the nonce policy from proxy.ts instead.
      { source: "/(api|_next|uploads)/:path*", headers: [staticPolicyHeader] },
    ];
  },
};

export default nextConfig;
