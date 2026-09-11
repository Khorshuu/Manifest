import { and, desc, eq, ne, sql } from "drizzle-orm";
import { effectivePriceExpression } from "./price";
import { db } from "@/db";
import { products } from "@/db/schema";
import { publicProductWhere } from "./facets";
import { listProductCards, type ProductCard } from "./storefront";

/**
 * What else a shopper might want, decided from what the catalogue actually
 * records rather than from chance.
 *
 * Five signals, weighted by how much they mean:
 *
 *  - **A relationship staff stated.** `product_related` exists for exactly
 *    this; a person deciding two products go together beats any heuristic.
 *  - **The same shelf.** The strongest automatic signal in a catalogue that
 *    files everything by hand.
 *  - **A shared tag.** Tags are how staff describe a product beyond its shelf
 *    — "travel", "gift", "seasonal" — so an overlap is a real similarity.
 *  - **The same brand.** Someone looking at one Northline product is a
 *    plausible buyer of another.
 *  - **A comparable price.** A BDT 400 tin is not an alternative to a BDT
 *    40,000 pair of headphones, whatever else they share.
 *
 * Nothing scoring zero is ever returned as a recommendation. When too few
 * products score at all — a young catalogue, a lone product on its shelf — the
 * row is topped up with what is genuinely popular, and that is a fallback the
 * shopper can see the sense of, unlike a random draw.
 */
export async function listRecommendations(
  productId: string,
  limit = 4,
): Promise<ProductCard[]> {
  const [subject] = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      brand: products.brand,
      tags: products.tags,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!subject) return [];

  const tags = Array.isArray(subject.tags)
    ? subject.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  /** The lowest purchasable price, for both the subject and each candidate. */
  const lowestPrice = sql`(
    select min(${sql.raw(effectivePriceExpression())}) from product_variants v
    where v.product_id = ${products.id}
      and v.is_enabled = true and v.archived_at is null
  )`;

  const subjectPrice = sql`(
    select min(${sql.raw(effectivePriceExpression())}) from product_variants v
    where v.product_id = ${productId}
      and v.is_enabled = true and v.archived_at is null
  )`;

  const score = sql<number>`(
    case when exists (
      select 1 from product_related r
      where r.product_id = ${productId} and r.related_product_id = ${products.id}
    ) then 10 else 0 end
    + case when ${products.categoryId} = ${subject.categoryId} then 4 else 0 end
    + case when ${products.brand} is not null and ${products.brand} = ${subject.brand ?? null} then 2 else 0 end
    + case when ${
      tags.length > 0
        ? sql`jsonb_typeof(${products.tags}) = 'array' and ${products.tags} ?| array[${sql.join(
            tags.map((tag) => sql`${tag}`),
            sql`, `,
          )}]::text[]`
        : sql`false`
    } then 3 else 0 end
    + case
        when ${subjectPrice} is null or ${lowestPrice} is null then 0
        when abs(${lowestPrice} - ${subjectPrice}) <= greatest(${subjectPrice} * 0.4, 50000) then 1
        else 0
      end
  )::int`;

  const rows = await db
    .select({ id: products.id, score })
    .from(products)
    .where(and(publicProductWhere, ne(products.id, productId)))
    .orderBy(desc(score), desc(products.createdAt))
    .limit(limit);

  const related = rows.filter((row) => row.score > 0).map((row) => row.id);

  /*
   * `listProductCards` is what every other row of products on the site goes
   * through, so a recommendation carries exactly the same facts as a card in a
   * listing — including the availability, which is what stops this row
   * recommending a batch that closed this morning.
   */
  const cards =
    related.length > 0
      ? await listProductCards({ limit: related.length, ids: related })
      : [];

  if (cards.length >= limit) return cards.slice(0, limit);

  // Topping up. Popular means reviewed and rated, which is the only popularity
  // this shop actually records — see docs/DECISIONS.md.
  const already = new Set([productId, ...cards.map((card) => card.id)]);
  const popular = await listProductCards({ sort: "rating", limit: limit + 4 });

  return [
    ...cards,
    ...popular.filter((card) => !already.has(card.id)),
  ].slice(0, limit);
}
