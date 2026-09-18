import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { queryRows, type Executor } from "@/lib/pkb/common";
import { siteUrl } from "./index";

/**
 * Technical SEO auditing (D-087).
 *
 * The checks here are about whether a page can be crawled, indexed and
 * understood at all — the layer beneath wording. They are deliberately about
 * this shop's own rows rather than about what Google has done: what Google has
 * done is Search Console's answer, and that is Stage 6.
 *
 * Every check states a fact that can be confirmed by opening the page, and
 * says what to change. Nothing here writes: a redirect that shadows a live
 * address, for instance, is reported for a person to resolve, because deleting
 * one automatically could break a link that is out in the world.
 */

/** Paths robots.txt keeps crawlers out of. Kept beside `app/robots.ts`. */
export const DISALLOWED_PREFIXES = ["/admin", "/account", "/cart", "/checkout", "/api", "/orders"];

export type TechnicalFinding = {
  id: string;
  label: string;
  detail: string;
  fix: string;
  severity: "required" | "recommended" | "optional";
};

export type ListingTechnicalAudit = {
  productId: string;
  slug: string;
  /** Whether this page may be indexed at all, and why not when it may not. */
  indexable: boolean;
  indexableReason: string;
  canonicalTarget: string;
  previousAddresses: string[];
  findings: TechnicalFinding[];
};

type ListingRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  archived_at: Date | null;
  seo_no_index: boolean;
  canonical_url: string | null;
  seo_meta_title: string | null;
  category_no_index: boolean;
  category_name: string;
  live_variants: number;
  previous: string[] | null;
  shadowed: string[] | null;
};

function isPublic(status: string): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(status);
}

/**
 * One listing's technical state. Used by the editor, and by the catalogue-wide
 * audit for the listings it reports.
 */
export async function listingTechnicalAudit(
  productId: string,
  executor: Executor = db,
): Promise<ListingTechnicalAudit | null> {
  const [row] = await queryRows<ListingRow>(
    executor,
    sql`
      select p.id::text as id, p.slug, p.title, p.status, p.archived_at, p.seo_no_index,
             p.canonical_url, p.seo_meta_title,
             c.seo_no_index as category_no_index, c.name as category_name,
             (select count(*)::int from product_variants v
              where v.product_id = p.id and v.archived_at is null and v.is_enabled) as live_variants,
             (select coalesce(array_agg(r.from_slug order by r.created_at), '{}')
              from product_slug_redirects r where r.product_id = p.id) as previous,
             (select coalesce(array_agg(r.from_slug order by r.created_at), '{}')
              from product_slug_redirects r
              join products live on live.slug = r.from_slug
              where r.product_id = p.id) as shadowed
      from products p
      join categories c on c.id = p.category_id
      where p.id = ${productId}
    `,
  );
  if (!row) return null;

  const findings: TechnicalFinding[] = [];
  const published = row.archived_at === null && isPublic(row.status);
  const indexable = published && !row.seo_no_index;
  const indexableReason = !published
    ? row.archived_at !== null
      ? "archived, so the page is gone"
      : `status is ${row.status}, so the page is not public`
    : row.seo_no_index
      ? "hidden from search on this listing"
      : "indexable";

  const canonicalTarget = row.canonical_url?.trim() ? row.canonical_url.trim() : `/products/${row.slug}`;

  if (indexable && row.canonical_url && row.canonical_url.trim() !== "") {
    const value = row.canonical_url.trim();
    const own = `/products/${row.slug}`;
    const sameSite = value.startsWith("/") || value.startsWith(siteUrl());
    if (!sameSite) {
      findings.push({
        id: "foreign_canonical",
        label: "Canonical address on another domain",
        detail: value,
        fix: "This tells search engines to show that page instead of this one. Clear it, or point it at a path on this site.",
        severity: "required",
      });
    } else if (!value.endsWith(own)) {
      findings.push({
        id: "canonical_elsewhere",
        label: "Canonical address points at a different page",
        detail: `${value}, not ${own}`,
        fix: "Deliberate for a duplicate listing. Otherwise clear it so the page speaks for itself.",
        severity: "recommended",
      });
    }
  }

  if (indexable && row.category_no_index) {
    findings.push({
      id: "shelf_hidden",
      label: "The shelf this sits on is hidden from search",
      detail: row.category_name,
      fix: "The listing is indexable but a crawler has no indexed path to it. Either show the shelf, or accept the listing will be found only through the sitemap.",
      severity: "optional",
    });
  }

  if (indexable && row.live_variants === 0) {
    findings.push({
      id: "no_offer",
      label: "Nothing a shopper can buy",
      detail: "no live variant",
      fix: "Without an offer the page cannot state a price, so it cannot carry a product rich result.",
      severity: "required",
    });
  }

  for (const slug of row.shadowed ?? []) {
    findings.push({
      id: `shadowed_redirect:${slug}`,
      label: "An old address of this listing is another listing's address",
      detail: `/products/${slug}`,
      fix: "The live listing wins and the redirect never runs. Give one of them a different address, or remove the old one.",
      severity: "recommended",
    });
  }

  if (published && DISALLOWED_PREFIXES.some((prefix) => `/products/${row.slug}`.startsWith(prefix))) {
    findings.push({
      id: "blocked_by_robots",
      label: "Address blocked by robots.txt",
      detail: `/products/${row.slug}`,
      fix: "Rename the listing: robots.txt keeps crawlers out of this path entirely.",
      severity: "required",
    });
  }

  if (indexable && (row.previous?.length ?? 0) > 3) {
    findings.push({
      id: "many_addresses",
      label: "The address has changed several times",
      detail: `${row.previous?.length} old address(es) redirect here`,
      fix: "Every change costs some of the page's standing. Settle on an address and keep it.",
      severity: "optional",
    });
  }

  return {
    productId: row.id,
    slug: row.slug,
    indexable,
    indexableReason,
    canonicalTarget,
    previousAddresses: row.previous ?? [],
    findings,
  };
}

export type TechnicalHealth = {
  /** Listings that may be indexed. */
  indexable: number;
  /** Public listings deliberately kept out of the index. */
  hiddenFromSearch: number;
  /** Published listings whose shelf is hidden, so nothing indexed links to them. */
  onHiddenShelf: number;
  /** Old addresses that a live listing now occupies, so the redirect never runs. */
  shadowedRedirects: { fromSlug: string; productId: string; title: string }[];
  /** Redirects whose listing is no longer public: the old address leads nowhere useful. */
  deadRedirects: { fromSlug: string; productId: string; title: string }[];
  /** Shelves with nothing published in them; they are already out of the sitemap. */
  emptyCategories: { id: string; name: string; slug: string }[];
  /** Shelves with no SEO title or description of their own. */
  categoriesWithoutMetadata: number;
  /** Categories hidden from search. */
  hiddenCategories: number;
};

export async function technicalHealth(executor: Executor = db): Promise<TechnicalHealth> {
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const [[counts], shadowed, dead, empty] = await Promise.all([
    queryRows<{
      indexable: number;
      hidden: number;
      on_hidden_shelf: number;
      categories_without_metadata: number;
      hidden_categories: number;
    }>(
      executor,
      sql`
        select
          count(*) filter (where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false)::int as indexable,
          count(*) filter (where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index)::int as hidden,
          count(*) filter (
            where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false
              and exists (select 1 from categories c where c.id = p.category_id and c.seo_no_index)
          )::int as on_hidden_shelf,
          (select count(*)::int from categories c
            where (c.seo_meta_title is null or btrim(c.seo_meta_title) = '')
               or (c.seo_meta_description is null or btrim(c.seo_meta_description) = '')) as categories_without_metadata,
          (select count(*)::int from categories c where c.seo_no_index) as hidden_categories
        from products p
      `,
    ),
    queryRows<{ from_slug: string; product_id: string; title: string }>(
      executor,
      sql`
        select r.from_slug, r.product_id::text as product_id, p.title
        from product_slug_redirects r
        join products p on p.id = r.product_id
        where exists (select 1 from products live where live.slug = r.from_slug)
        order by r.created_at desc
        limit 25
      `,
    ),
    queryRows<{ from_slug: string; product_id: string; title: string }>(
      executor,
      sql`
        select r.from_slug, r.product_id::text as product_id, p.title
        from product_slug_redirects r
        join products p on p.id = r.product_id
        where p.archived_at is not null or p.status <> all(${statuses}::text[])
        order by r.created_at desc
        limit 25
      `,
    ),
    queryRows<{ id: string; name: string; slug: string }>(
      executor,
      sql`
        with recursive descendants as (
          select c.id as root_id, c.id as node_id from categories c
          union all
          select d.root_id, child.id
          from descendants d
          join categories child on child.parent_id = d.node_id
        )
        select c.id::text as id, c.name, c.slug
        from categories c
        where not exists (
          select 1 from descendants d
          join products p on p.category_id = d.node_id
          where d.root_id = c.id
            and p.archived_at is null
            and p.status = any(${statuses}::text[])
            and p.seo_no_index = false
        )
        order by c.name
        limit 50
      `,
    ),
  ]);

  return {
    indexable: counts?.indexable ?? 0,
    hiddenFromSearch: counts?.hidden ?? 0,
    onHiddenShelf: counts?.on_hidden_shelf ?? 0,
    shadowedRedirects: shadowed.map((row) => ({ fromSlug: row.from_slug, productId: row.product_id, title: row.title })),
    deadRedirects: dead.map((row) => ({ fromSlug: row.from_slug, productId: row.product_id, title: row.title })),
    emptyCategories: empty,
    categoriesWithoutMetadata: counts?.categories_without_metadata ?? 0,
    hiddenCategories: counts?.hidden_categories ?? 0,
  };
}
