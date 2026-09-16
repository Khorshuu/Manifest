import type { MetadataRoute } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { categories, products } from "@/db/schema";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { CACHE_TAGS } from "@/lib/cache";
import { siteUrl } from "@/lib/seo";


/**
 * The sitemap lists only what a shopper can actually reach: no drafts, no
 * archived products, and none of the account or checkout pages, which are
 * marked noindex anyway.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const { productRows, categoryRows } = await sitemapRows();

  return [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/help`, changeFrequency: "monthly", priority: 0.3 },
    ...categoryRows.map((row) => ({
      url: `${base}/categories/${row.slug}`,
      lastModified: new Date(row.updatedAt),
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
    ...productRows.map((row) => ({
      url: `${base}/products/${row.slug}`,
      lastModified: new Date(row.updatedAt),
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
  ];
}

/**
 * Cached for an hour and dropped when the catalogue changes (lib/cache.ts).
 * Without it the sitemap would be read once at build and never again.
 */
async function sitemapRows() {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.listing, CACHE_TAGS.categories);

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

  return {
    productRows: productRows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() })),
    categoryRows: categoryRows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() })),
  };
}
