import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

/**
 * Account, checkout, cart, and admin are disallowed: they are per-user pages
 * with nothing to index, and keeping them out avoids a crawler wandering
 * through a checkout.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/account", "/cart", "/checkout", "/api", "/orders"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
