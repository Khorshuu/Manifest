import type { MetadataRoute } from "next";
import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { categories, products } from "@/db/schema";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

/**
 * The sitemap lists only what a shopper can actually reach: no drafts, no
 * archived products, and none of the account or checkout pages, which are
 * marked noindex anyway.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const [productRows, categoryRows] = await Promise.all([
    db
      .select({ slug: products.slug, updatedAt: products.updatedAt })
      .from(products)
      .where(
        and(
          isNull(products.archivedAt),
          inArray(products.status, [...PUBLIC_STATUSES]),
        ),
      ),
    db.select({ slug: categories.slug, updatedAt: categories.updatedAt }).from(categories),
  ]);

  return [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/help`, changeFrequency: "monthly", priority: 0.3 },
    ...categoryRows.map((row) => ({
      url: `${base}/categories/${row.slug}`,
      lastModified: row.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
    ...productRows.map((row) => ({
      url: `${base}/products/${row.slug}`,
      lastModified: row.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
  ];
}
