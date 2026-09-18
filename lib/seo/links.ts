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
