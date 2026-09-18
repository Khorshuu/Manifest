import type { MetadataRoute } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { CACHE_TAGS } from "@/lib/cache";
import { siteUrl } from "@/lib/seo";

/**
 * The sitemap lists only what a shopper can actually reach: no drafts, no
 * archived products, none of the account or checkout pages, and — since D-082
 * — no category that has nothing in it and no listing that has been hidden
 * from search (finding F15).
 *
 * `lastModified` is the latest change to anything the page shows: the listing
 * row, its photographs or its offers. Using only `products.updated_at` told
 * crawlers nothing had changed when a price or a photograph had.
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
      // Image entries let Google Images find the photography, which is a real
      // source of product traffic. Only gallery photographs, in the order the
      // page shows them.
      images: row.images.map((path) => `${base}${path}`),
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

  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const productResult = await db.execute(sql`
    select p.slug,
           greatest(
             p.updated_at,
             coalesce((select max(i.created_at) from product_images i where i.product_id = p.id), p.updated_at),
             coalesce((select max(v.updated_at) from product_variants v
                       where v.product_id = p.id and v.archived_at is null), p.updated_at)
           ) as updated_at,
           coalesce((select array_agg(i.url order by i.sort_order, i.created_at)
                     from product_images i
                     where i.product_id = p.id and i.kind = 'gallery'), '{}') as images
    from products p
    where p.archived_at is null
      and p.status = any(${statuses}::text[])
      and p.seo_no_index = false
    order by p.updated_at desc
  `);

  /*
   * A category with nothing published in it, and no published descendant, is a
   * page a crawler reaches and finds empty; listing it wastes crawl budget and
   * invites a thin-content judgement.
   */
  const categoryResult = await db.execute(sql`
    with recursive descendants as (
      select c.id as root_id, c.id as node_id from categories c
      union all
      select d.root_id, child.id
      from descendants d
      join categories child on child.parent_id = d.node_id
    )
    select c.slug, c.updated_at
    from categories c
    where c.seo_no_index = false
      and exists (
      select 1 from descendants d
      join products p on p.category_id = d.node_id
      where d.root_id = c.id
        and p.archived_at is null
        and p.status = any(${statuses}::text[])
        and p.seo_no_index = false
    )
    order by c.slug
  `);

  const rows = <T>(result: unknown): T[] =>
    Array.isArray(result) ? (result as T[]) : (((result as { rows?: T[] }).rows ?? []) as T[]);

  return {
    productRows: rows<{ slug: string; updated_at: Date | string; images: string[] | null }>(productResult).map((row) => ({
      slug: row.slug,
      updatedAt: new Date(row.updated_at).toISOString(),
      images: row.images ?? [],
    })),
    categoryRows: rows<{ slug: string; updated_at: Date | string }>(categoryResult).map((row) => ({
      slug: row.slug,
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  };
}
