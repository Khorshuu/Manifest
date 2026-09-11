import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  categories,
  productImages,
  productVariants,
  products,
  reviews,
  siteSettings,
  variantOptionValues,
} from "@/db/schema";
import {
  relevanceAdjustment,
  relevanceTier,
  textArray,
  type SearchPlan,
} from "@/lib/search/sql";
import { effectivePriceExpression, effectivePriceSql } from "./price";
import { loadCardAggregates } from "./card-data";
import {
  buyableNowSql,
  discountSql,
  prepareFilters,
  productSearchJoin,
  publicProductWhere,
  ratingAverageSql,
  salesUnitsSql,
  whereFor,
  type ProductFilters,
} from "./facets";

export { suggestSearch, type Suggestion } from "@/lib/search/suggest";

/**
 * Queries that serve shoppers.
 *
 * These are deliberately separate from the admin ones rather than a flag on
 * them: none of these can return a draft, an archived product, or the internal
 * sourcing cost, so a missed conditional cannot leak them
 * (docs/BUSINESS_LOGIC.md).
 */

export type ProductCard = {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  status: string;
  /**
   * One line about the product, for the card.
   *
   * Taken from the listing's own words — its first selling point, or the
   * opening of its description with the markup removed. Never written here:
   * a card that invents a description is a card that lies about a product.
   */
  summary: string | null;
  imageUrl: string | null;
  imageAlt: string;
  /** Lowest price across purchasable variants, in BDT paisa. */
  fromPriceBdt: number | null;
  /** The regular price that sale is a saving against; null with no sale. */
  listPriceBdt: number | null;
  discountPercent: number | null;
  /** In-stock goods only, and none left. */
  outOfStock: boolean;
  fulfillmentMode: string | null;
  /** Null when uncapped, 0 when full. */
  remainingCapacity: number | null;
  /** Every slot in the batch, taken or not. Null when nothing is capped. */
  totalCapacity: number | null;
  closesAt: Date | null;
  /** The preorder window shuts within three days. Decided in SQL. */
  closingSoon: boolean;
  arrivesFrom: Date | null;
  arrivesTo: Date | null;
  ratingAverage: number | null;
  reviewCount: number;
};

type ProductRow = {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  status: string;
  descriptionHtml: string | null;
  bulletFeatures: unknown;
};

const productColumns = {
  id: products.id,
  title: products.title,
  slug: products.slug,
  brand: products.brand,
  status: products.status,
  descriptionHtml: products.descriptionHtml,
  bulletFeatures: products.bulletFeatures,
};

/**
 * The one-line description a card shows.
 *
 * The first bullet point if the listing has one — those are written as short
 * claims already — and otherwise the opening of the description with its tags
 * stripped. Trimmed on a word boundary, because a sentence cut mid-word reads
 * as a rendering fault rather than as an abbreviation.
 */
const SUMMARY_LIMIT = 110;

function summarise(row: ProductRow): string | null {
  const bullets = Array.isArray(row.bulletFeatures)
    ? row.bulletFeatures.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      )
    : [];

  const source =
    bullets[0] ??
    (row.descriptionHtml
      ? row.descriptionHtml
          .replace(/<[^>]*>/g, " ")
          .replace(/&[a-z]+;/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "");

  if (!source) return null;
  if (source.length <= SUMMARY_LIMIT) return source;

  const clipped = source.slice(0, SUMMARY_LIMIT);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).replace(/[,.;:]$/, "")}…`;
}

/** Joins the base rows to their aggregates in one further round of queries. */
async function toCards(rows: ProductRow[]): Promise<ProductCard[]> {
  const aggregates = await loadCardAggregates(rows.map((row) => row.id));

  return rows.map((row) => {
    const aggregate = aggregates.get(row.id);
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      brand: row.brand,
      status: row.status,
      summary: summarise(row),
      imageUrl: aggregate?.imageUrl ?? null,
      imageAlt: aggregate?.imageAlt ?? row.title,
      fromPriceBdt: aggregate?.fromPriceBdt ?? null,
      listPriceBdt: aggregate?.listPriceBdt ?? null,
      discountPercent: aggregate?.discountPercent ?? null,
      outOfStock: aggregate?.outOfStock ?? false,
      fulfillmentMode: aggregate?.fulfillmentMode ?? null,
      remainingCapacity: aggregate?.remainingCapacity ?? null,
      totalCapacity: aggregate?.totalCapacity ?? null,
      closesAt: aggregate?.closesAt ?? null,
      closingSoon: aggregate?.closingSoon ?? false,
      arrivesFrom: aggregate?.arrivesFrom ?? null,
      arrivesTo: aggregate?.arrivesTo ?? null,
      ratingAverage: aggregate?.ratingAverage ?? null,
      reviewCount: aggregate?.reviewCount ?? 0,
    };
  });
}

export const PRODUCT_SORTS = [
  "relevance",
  "featured",
  "price_asc",
  "price_desc",
  "rating",
  "newest",
  "best_selling",
  "discount",
] as const;

export type ProductSort = (typeof PRODUCT_SORTS)[number];

/** A sort from the URL, or the fallback when it is missing or unknown. */
export function parseSort(value: unknown, fallback: ProductSort): ProductSort {
  return typeof value === "string" &&
    (PRODUCT_SORTS as readonly string[]).includes(value)
    ? (value as ProductSort)
    : fallback;
}

/**
 * Secondary signals within a relevance tier: what sells, what is rated well,
 * what can be bought today, and what is new. Bounded — together they can move
 * a product about fifty points, which is less than one tier is worth once the
 * text adjustments are counted, and ordering is by tier first anyway.
 */
const popularitySql = sql`(
  least(15.0, 6 * ln(1 + ${salesUnitsSql}))
  + coalesce((${ratingAverageSql} - 3) * 3, 0)
  + case when ${buyableNowSql} then 6 else -6 end
  + case when ${products.createdAt} > now() - interval '30 days' then 4 else 0 end
)`;

/** The cheapest purchasable variant, as charged. */
const fromPriceSql = sql`(
  select min(${sql.raw(effectivePriceExpression())}) from product_variants v
  where v.product_id = ${products.id}
    and v.is_enabled = true and v.archived_at is null
)`;

/**
 * The products staff put on the homepage, in their order — what "Featured"
 * means in this shop. Read here rather than through lib/homepage so the
 * catalogue does not depend on the homepage module.
 */
async function showcaseSlugs(): Promise<string[]> {
  const [row] = await db
    .select({ valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, "home.showcase"))
    .limit(1);

  const slugs = (row?.valueJson as { value?: { slugs?: unknown } } | undefined)
    ?.value?.slugs;

  return Array.isArray(slugs)
    ? slugs.filter((slug): slug is string => typeof slug === "string").slice(0, 20)
    : [];
}

/**
 * The ORDER BY for a sort.
 *
 * With a search behind it, "relevance" is the tiered ranking in
 * lib/search/sql.ts — tier first, then the text, the staff boost and the
 * popularity signals within the tier. Every other sort keeps the relevance
 * order as its tie-break, so two products at the same price still come back
 * best answer first. With no search there is nothing to be relevant to, so
 * relevance falls back to newest first.
 */
async function orderFor(
  sort: ProductSort,
  plan: SearchPlan | null,
): Promise<SQL[]> {
  const relevance = plan
    ? [
        sql`${relevanceTier(plan)} desc`,
        sql`(${relevanceAdjustment(plan)} + ${popularitySql}) desc`,
      ]
    : [];
  const newest = [desc(products.createdAt), asc(products.id)];

  switch (sort) {
    case "featured": {
      const slugs = await showcaseSlugs();
      return [
        sql`array_position(${textArray(slugs)}, ${products.slug}) asc nulls last`,
        desc(products.searchBoost),
        ...relevance,
        ...newest,
      ];
    }
    case "price_asc":
      return [asc(sql`coalesce(${fromPriceSql}, 2147483647)`), ...relevance, ...newest];
    case "price_desc":
      return [desc(sql`coalesce(${fromPriceSql}, 0)`), ...relevance, ...newest];
    case "rating":
      return [
        sql`${ratingAverageSql} desc nulls last`,
        desc(sql`(select count(*) from reviews rv
          where rv.product_id = ${products.id} and rv.status = 'approved')`),
        ...relevance,
        ...newest,
      ];
    case "best_selling":
      return [desc(salesUnitsSql), ...relevance, ...newest];
    case "discount":
      return [sql`${discountSql} desc nulls last`, ...relevance, ...newest];
    case "newest":
      return newest;
    case "relevance":
    default:
      return plan ? [...relevance, ...newest] : newest;
  }
}

export type ListProductsOptions = ProductFilters & {
  sort?: ProductSort;
  limit?: number;
  offset?: number;
};

export async function listProductCards(
  options: ListProductsOptions = {},
): Promise<ProductCard[]> {
  const prepared = await prepareFilters(options);
  const sort = options.sort ?? (prepared.plan ? "relevance" : "newest");

  const rows = await db
    .select(productColumns)
    .from(products)
    .leftJoin(productSearchJoin.table, productSearchJoin.on)
    .where(whereFor(prepared))
    .orderBy(...(await orderFor(sort, prepared.plan)))
    .limit(options.limit ?? 24)
    .offset(options.offset ?? 0);

  return toCards(rows);
}

/**
 * Counts exactly what `listProductCards` would return for the same filters.
 * Both go through `whereFor` so the two cannot drift — they did once, and a
 * filtered listing reported more pages than it had.
 */
export async function countProducts(
  filters: ProductFilters = {},
): Promise<number> {
  const prepared = await prepareFilters(filters);

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(products)
    .leftJoin(productSearchJoin.table, productSearchJoin.on)
    .where(whereFor(prepared));

  return Number(row.value);
}

/** Distinct brands within a result set, for the brand facet. */
export async function listBrands(categoryIds?: string[]): Promise<string[]> {
  const filters = [publicProductWhere, sql`${products.brand} is not null`];
  if (categoryIds?.length) {
    filters.push(inArray(products.categoryId, categoryIds));
  }

  const rows = await db
    .selectDistinct({ brand: products.brand })
    .from(products)
    .where(and(...filters))
    .orderBy(asc(products.brand));

  return rows
    .map((row) => row.brand)
    .filter((brand): brand is string => Boolean(brand));
}

export async function getCategoryBySlug(slug: string) {
  const [category] = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      parentId: categories.parentId,
    })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);

  return category ?? null;
}

/**
 * Variants a shopper may buy, with the option values that name them. Note the
 * absence of cost_price_usd — this query cannot return it.
 */
export async function getPublicVariants(productId: string) {
  const variants = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      /* The price as charged: a live sale price, otherwise the regular one.
         `listPriceBdt` is kept beside it so the page can show what a sale is
         a saving against, rather than asserting a discount it cannot show. */
      priceBdt: effectivePriceSql,
      listPriceBdt: productVariants.priceBdt,
      salePriceBdt: productVariants.salePriceBdt,
      saleEndsAt: productVariants.saleEndsAt,
      fulfillmentMode: productVariants.fulfillmentMode,
      stockQuantity: productVariants.stockQuantity,
      lowStockThreshold: productVariants.lowStockThreshold,
      preorderCapacity: productVariants.preorderCapacity,
      preorderReserved: productVariants.preorderReserved,
      preorderClosesAt: productVariants.preorderClosesAt,
      estimatedArrivalFrom: productVariants.estimatedArrivalFrom,
      estimatedArrivalTo: productVariants.estimatedArrivalTo,
      paymentMode: productVariants.paymentMode,
      depositPercent: productVariants.depositPercent,
      /*
       * The database decides whether the window has closed, so there is one
       * clock for the whole system rather than one per rendering process.
       */
      isClosed: sql<boolean>`(${productVariants.preorderClosesAt} is not null
        and ${productVariants.preorderClosesAt} <= now())`,
      /* The variant's own photograph, if staff chose one. The id is named in
         full: a bare "id" inside the subquery would be the image's own. */
      imageUrl: sql<string | null>`(select vi.url from variant_images vi
        where vi.variant_id = ${sql.raw(`"product_variants"."id"`)}
        order by vi.sort_order limit 1)`,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    )
    .orderBy(asc(effectivePriceSql));

  if (variants.length === 0) return [];

  const options = await db
    .select({
      variantId: variantOptionValues.variantId,
      attributeName: attributes.name,
      value: attributeValues.value,
    })
    .from(variantOptionValues)
    .innerJoin(attributes, eq(variantOptionValues.attributeId, attributes.id))
    .innerJoin(
      attributeValues,
      eq(variantOptionValues.attributeValueId, attributeValues.id),
    )
    .where(
      inArray(
        variantOptionValues.variantId,
        variants.map((variant) => variant.id),
      ),
    );

  return variants.map((variant) => {
    const mine = options.filter((option) => option.variantId === variant.id);
    return {
      ...variant,
      options: mine.map((option) => ({
        name: option.attributeName,
        value: option.value,
      })),
      label: mine.map((option) => option.value).join(" / ") || "Standard",
    };
  });
}

/** Other products in the same category. Simple by design — see DECISIONS.md. */
export async function listRelatedProducts(
  productId: string,
  categoryId: string,
  limit = 4,
): Promise<ProductCard[]> {
  const rows = await db
    .select(productColumns)
    .from(products)
    .where(
      and(
        publicProductWhere,
        eq(products.categoryId, categoryId),
        sql`${products.id} <> ${productId}`,
      ),
    )
    .orderBy(desc(products.createdAt))
    .limit(limit);

  return toCards(rows);
}

/** Open preorders closing soonest — the homepage's trending row. */
export async function listClosingSoon(limit = 4): Promise<ProductCard[]> {
  const rows = await db
    .select(productColumns)
    .from(products)
    .where(and(publicProductWhere, eq(products.status, "preorder_open")))
    .orderBy(
      asc(sql`(
        select min(v.preorder_closes_at) from product_variants v
        where v.product_id = ${products.id}
          and v.is_enabled = true and v.archived_at is null
      )`),
    )
    .limit(limit);

  return toCards(rows);
}

/**
 * One card by slug, or null.
 *
 * Used by the homepage hero, where staff may have named the product it
 * features. It goes through the same public predicate as every other shopper
 * query, so a hero pointed at a draft or an archived product shows the
 * fallback rather than an unpublished listing.
 */
export async function getProductCardBySlug(
  slug: string,
): Promise<ProductCard | null> {
  const rows = await db
    .select(productColumns)
    .from(products)
    .where(and(publicProductWhere, eq(products.slug, slug)))
    .limit(1);

  if (rows.length === 0) return null;

  const [card] = await toCards(rows);
  return card ?? null;
}

/**
 * Cards for a list of product ids, in the order given.
 *
 * Used for "recently viewed", where the ids come from a cookie the browser
 * holds. They go through the public predicate like every other shopper query,
 * so an id for a draft, an archived product or something invented simply
 * yields nothing.
 */
export async function listProductCardsByIds(
  ids: string[],
): Promise<ProductCard[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select(productColumns)
    .from(products)
    .where(and(publicProductWhere, inArray(products.id, ids)));

  const cards = await toCards(rows);
  const byId = new Map(cards.map((card) => [card.id, card]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Kept for the review aggregate used on the product page. */
export async function getProductRating(productId: string) {
  const [row] = await db
    .select({
      average: sql<string | null>`round(avg(${reviews.rating})::numeric, 1)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(
      and(eq(reviews.productId, productId), eq(reviews.status, "approved")),
    );

  return {
    average: row.average === null ? null : Number(row.average),
    count: Number(row.count),
  };
}

/**
 * How many public listings sit in each category, counted once for the whole
 * tree rather than a query per tile.
 *
 * A product is counted against its own category only. Rolling a child's
 * products up into its parent would double-count them on a page that shows
 * both, and the category pages themselves already include the subtree — so the
 * number on a tile is "listings filed here", which is what the tile says.
 */
export async function countPublicProductsByCategory(): Promise<
  Map<string, number>
> {
  const rows = await db
    .select({
      categoryId: products.categoryId,
      total: sql<number>`count(*)::int`,
    })
    .from(products)
    .where(publicProductWhere)
    .groupBy(products.categoryId);

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.categoryId) continue;
    counts.set(row.categoryId, Number(row.total));
  }
  return counts;
}

/**
 * One representative photograph per category: the first image of the
 * lowest-sorted public product filed there.
 *
 * A category tile with real goods on it reads as a shelf in a shop. The
 * generated artwork that stood in before was drawn for square product cards,
 * and at tile proportions it became a large initial across the panel — which
 * looked like a placeholder, because it was one.
 *
 * Keyed by the category the product is filed in. Callers that show a top-level
 * category roll its descendants up themselves, since only they know the tree.
 */
export async function pickCategoryImages(): Promise<
  Map<string, { url: string; altText: string }>
> {
  const rows = await db
    .selectDistinctOn([products.categoryId], {
      categoryId: products.categoryId,
      url: productImages.url,
      altText: productImages.altText,
    })
    .from(products)
    .innerJoin(productImages, eq(productImages.productId, products.id))
    .where(publicProductWhere)
    .orderBy(products.categoryId, productImages.sortOrder, products.createdAt);

  const picks = new Map<string, { url: string; altText: string }>();
  for (const row of rows) {
    if (!row.categoryId) continue;
    picks.set(row.categoryId, { url: row.url, altText: row.altText });
  }
  return picks;
}
