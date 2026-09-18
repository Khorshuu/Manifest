import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { queryRows, type Executor } from "@/lib/pkb/common";

/**
 * Internal links from established relationships (D-083).
 *
 * A product page that links to the accessory that fits it, the model it
 * replaced and the rest of its series helps a shopper and gives a crawler a
 * path through the catalogue. The links come from `pkb_relationships`, which
 * only holds relationships a person accepted, so nothing here invents a
 * connection: with no recorded relationship the block does not render, and the
 * page keeps the ordinary "same shelf" row it always had.
 *
 * Only relationships pointing at a listing a shopper can reach are returned —
 * a link to a knowledge product with no listing, or to a draft, would be a
 * dead end.
 */

export type KnowledgeLinkGroup = {
  kind: string;
  /** How the relationship reads from this product's side. */
  label: string;
  products: { id: string; title: string; slug: string; imageUrl: string | null }[];
};

const LABELS: Record<string, { outgoing: string; incoming: string }> = {
  accessory_for: { outgoing: "Works with", incoming: "Accessories" },
  compatible_with: { outgoing: "Compatible with", incoming: "Compatible with" },
  successor_of: { outgoing: "Replaces", incoming: "Replaced by" },
  replacement_for: { outgoing: "Replacement for", incoming: "Replaced by" },
  bundle_contains: { outgoing: "Includes", incoming: "Included in" },
  requires: { outgoing: "Requires", incoming: "Required by" },
  related_to: { outgoing: "Related", incoming: "Related" },
  same_series: { outgoing: "Same series", incoming: "Same series" },
};

const SYMMETRIC = new Set(["compatible_with", "related_to", "same_series"]);

/** Links for one listing, grouped by what the relationship means. */
export async function knowledgeLinks(
  pkbProductId: string | null,
  options: { limitPerKind?: number } = {},
  executor: Executor = db,
): Promise<KnowledgeLinkGroup[]> {
  if (!pkbProductId) return [];
  const limit = Math.min(Math.max(options.limitPerKind ?? 4, 1), 12);
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const rows = await queryRows<{
    kind: string;
    outgoing: boolean;
    product_id: string;
    title: string;
    slug: string;
    image_url: string | null;
  }>(
    executor,
    sql`
      select r.kind,
             (r.from_product_id = ${pkbProductId}) as outgoing,
             p.id as product_id, p.title, p.slug,
             (select i.url from product_images i
              where i.product_id = p.id and i.kind = 'gallery'
              order by i.sort_order, i.created_at limit 1) as image_url
      from pkb_relationships r
      join products p on p.pkb_product_id = case
        when r.from_product_id = ${pkbProductId} then r.to_product_id else r.from_product_id end
      where (r.from_product_id = ${pkbProductId} or r.to_product_id = ${pkbProductId})
        and r.verification_state in ('VERIFIED', 'MANUAL')
        and p.archived_at is null
        and p.status = any(${statuses}::text[])
      order by r.kind, p.title
    `,
  );

  const groups = new Map<string, KnowledgeLinkGroup>();
  for (const row of rows) {
    const direction = SYMMETRIC.has(row.kind) || row.outgoing ? "outgoing" : "incoming";
    const label = LABELS[row.kind]?.[direction] ?? "Related";
    const key = `${row.kind}|${direction}`;
    const group = groups.get(key) ?? { kind: row.kind, label, products: [] };
    if (group.products.length < limit && !group.products.some((product) => product.id === row.product_id)) {
      group.products.push({ id: row.product_id, title: row.title, slug: row.slug, imageUrl: row.image_url });
    }
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.products.length > 0);
}

/**
 * Internal-link intelligence (D-088).
 *
 * The links above are what the page renders. These are the questions a person
 * asks about the whole catalogue: which listings nothing points at, which
 * accepted relationships lead nowhere a shopper can go, and where a link is
 * probably missing.
 *
 * Suggestions are suggestions. Nothing here creates a relationship — a
 * relationship is a claim about the products, and claims are decided in the
 * knowledge base with evidence behind them (I-1, D-076). What this returns is
 * a list of pairs a person may want to look at, with the reason stated.
 */

export type OrphanListing = { id: string; title: string; slug: string; categoryName: string };

export type BrokenLink = {
  kind: string;
  fromProductId: string;
  fromTitle: string;
  /** Why the link cannot be rendered: no listing, or a listing shoppers cannot reach. */
  reason: string;
};

export type LinkSuggestion = {
  fromProductId: string;
  fromTitle: string;
  toProductId: string;
  toTitle: string;
  /** The established facts the two have in common. */
  reason: string;
};

export type LinkIntelligence = {
  /** Published listings with no internal link pointing at them, bar their shelf. */
  orphans: OrphanListing[];
  orphanCount: number;
  /** Accepted relationships that cannot be rendered. */
  broken: BrokenLink[];
  /** Pairs worth a relationship, for a person to decide on. */
  suggestions: LinkSuggestion[];
  /** Links actually rendered across the catalogue. */
  renderedLinks: number;
};

export async function linkIntelligence(executor: Executor = db): Promise<LinkIntelligence> {
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const [orphans, [{ orphan_count: orphanCount }], broken, suggestions, [{ rendered }]] = await Promise.all([
    queryRows<{ id: string; title: string; slug: string; category_name: string }>(
      executor,
      sql`
        select p.id::text as id, p.title, p.slug, c.name as category_name
        from products p
        join categories c on c.id = p.category_id
        where p.archived_at is null
          and p.status = any(${statuses}::text[])
          and p.seo_no_index = false
          and not exists (
            select 1 from product_related pr
            join products source on source.id = pr.product_id
            where pr.related_product_id = p.id
              and source.archived_at is null
              and source.status = any(${statuses}::text[])
          )
          and not exists (
            select 1 from pkb_relationships r
            join products source on source.pkb_product_id in (r.from_product_id, r.to_product_id)
            where p.pkb_product_id in (r.from_product_id, r.to_product_id)
              and source.id <> p.id
              and r.verification_state in ('VERIFIED', 'MANUAL')
              and source.archived_at is null
              and source.status = any(${statuses}::text[])
          )
        order by p.updated_at desc
        limit 25
      `,
    ),
    queryRows<{ orphan_count: number }>(
      executor,
      sql`
        select count(*)::int as orphan_count
        from products p
        where p.archived_at is null
          and p.status = any(${statuses}::text[])
          and p.seo_no_index = false
          and not exists (
            select 1 from product_related pr
            join products source on source.id = pr.product_id
            where pr.related_product_id = p.id
              and source.archived_at is null
              and source.status = any(${statuses}::text[])
          )
          and not exists (
            select 1 from pkb_relationships r
            join products source on source.pkb_product_id in (r.from_product_id, r.to_product_id)
            where p.pkb_product_id in (r.from_product_id, r.to_product_id)
              and source.id <> p.id
              and r.verification_state in ('VERIFIED', 'MANUAL')
              and source.archived_at is null
              and source.status = any(${statuses}::text[])
          )
      `,
    ),
    queryRows<{ kind: string; from_product_id: string; from_title: string; reason: string }>(
      executor,
      sql`
        select r.kind,
               source.id::text as from_product_id,
               source.title as from_title,
               case when target.id is null then 'the other product has no listing'
                    else 'the other listing is not public' end as reason
        from pkb_relationships r
        join products source on source.pkb_product_id = r.from_product_id
        left join products target on target.pkb_product_id = r.to_product_id
        where r.verification_state in ('VERIFIED', 'MANUAL')
          and source.archived_at is null
          and source.status = any(${statuses}::text[])
          and (
            target.id is null
            or target.archived_at is not null
            or target.status <> all(${statuses}::text[])
          )
        order by source.title
        limit 25
      `,
    ),
    queryRows<{ from_product_id: string; from_title: string; to_product_id: string; to_title: string; reason: string }>(
      executor,
      sql`
        with branded as (
          select p.id as product_id, p.title, kp.id as pkb_id, kp.family_id,
                 f.value_brand_id as brand_id
          from products p
          join pkb_products kp on kp.id = p.pkb_product_id
          join pkb_facts f on f.pkb_product_id = kp.id and f.pkb_variant_id is null
          join pkb_attribute_definitions d on d.id = f.definition_id and d.key = 'brand'
          where f.value_brand_id is not null
            and f.verification_state in ('VERIFIED', 'MANUAL')
            and kp.family_id is not null
            and p.archived_at is null
            and p.status = any(${statuses}::text[])
            and p.seo_no_index = false
        )
        select a.product_id::text as from_product_id, a.title as from_title,
               b.product_id::text as to_product_id, b.title as to_title,
               'same established brand and the same product family' as reason
        from branded a
        join branded b on b.brand_id = a.brand_id and b.family_id = a.family_id
          and a.product_id < b.product_id
        where not exists (
          select 1 from pkb_relationships r
          where (r.from_product_id = a.pkb_id and r.to_product_id = b.pkb_id)
             or (r.from_product_id = b.pkb_id and r.to_product_id = a.pkb_id)
        )
        order by a.title, b.title
        limit 25
      `,
    ),
    queryRows<{ rendered: number }>(
      executor,
      sql`
        select count(*)::int as rendered
        from pkb_relationships r
        join products source on source.pkb_product_id = r.from_product_id
        join products target on target.pkb_product_id = r.to_product_id
        where r.verification_state in ('VERIFIED', 'MANUAL')
          and source.archived_at is null and source.status = any(${statuses}::text[])
          and target.archived_at is null and target.status = any(${statuses}::text[])
      `,
    ),
  ]);

  return {
    orphans: orphans.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      categoryName: row.category_name,
    })),
    orphanCount: orphanCount ?? 0,
    broken: broken.map((row) => ({
      kind: row.kind,
      fromProductId: row.from_product_id,
      fromTitle: row.from_title,
      reason: row.reason,
    })),
    suggestions: suggestions.map((row) => ({
      fromProductId: row.from_product_id,
      fromTitle: row.from_title,
      toProductId: row.to_product_id,
      toTitle: row.to_title,
      reason: row.reason,
    })),
    renderedLinks: rendered ?? 0,
  };
}
