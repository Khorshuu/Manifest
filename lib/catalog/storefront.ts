import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  categories,
  productVariants,
  products,
  reviews,
  variantOptionValues,
} from "@/db/schema";
import { loadCardAggregates } from "./card-data";
import { PUBLIC_STATUSES } from "./products";

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
  imageUrl: string | null;
  imageAlt: string;
  /** Lowest price across purchasable variants, in BDT paisa. */
  fromPriceBdt: number | null;
  fulfillmentMode: string | null;
  /** Null when uncapped, 0 when full. */
  remainingCapacity: number | null;
  closesAt: Date | null;
  arrivesFrom: Date | null;
  arrivesTo: Date | null;
  ratingAverage: number | null;
  reviewCount: number;
};

const publicProductWhere = and(
  isNull(products.archivedAt),
  inArray(products.status, [...PUBLIC_STATUSES]),
);

type ProductRow = {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  status: string;
};

const productColumns = {
  id: products.id,
  title: products.title,
  slug: products.slug,
  brand: products.brand,
  status: products.status,
};

/** Joins the base rows to their aggregates in one further round of queries. */
async function toCards(rows: ProductRow[]): Promise<ProductCard[]> {
  const aggregates = await loadCardAggregates(rows.map((row) => row.id));

  return rows.map((row) => {
    const aggregate = aggregates.get(row.id);
    return {
      ...row,
      imageUrl: aggregate?.imageUrl ?? null,
      imageAlt: aggregate?.imageAlt ?? row.title,
      fromPriceBdt: aggregate?.fromPriceBdt ?? null,
      fulfillmentMode: aggregate?.fulfillmentMode ?? null,
      remainingCapacity: aggregate?.remainingCapacity ?? null,
      closesAt: aggregate?.closesAt ?? null,
      arrivesFrom: aggregate?.arrivesFrom ?? null,
      arrivesTo: aggregate?.arrivesTo ?? null,
      ratingAverage: aggregate?.ratingAverage ?? null,
      reviewCount: aggregate?.reviewCount ?? 0,
    };
  });
}

export type ProductSort =
  | "relevance"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "newest";

/**
 * Sorting by a per-product aggregate needs it in the same query, so these use
 * a lateral join rather than a bare subquery — the join keeps the outer table
 * in scope, which is exactly what the correlated subqueries lacked.
 */
function sortedProductIds(sort: ProductSort) {
  switch (sort) {
    case "price_asc":
    case "price_desc": {
      const price = sql`(
        select min(v.price_bdt) from product_variants v
        where v.product_id = ${products.id}
          and v.is_enabled = true and v.archived_at is null
      )`;
      return sort === "price_asc"
        ? asc(sql`coalesce(${price}, 2147483647)`)
        : desc(sql`coalesce(${price}, 0)`);
    }
    case "rating":
      return desc(sql`(
        select coalesce(avg(r.rating), 0) from reviews r
        where r.product_id = ${products.id} and r.status = 'approved'
      )`);
    case "newest":
    case "relevance":
    default:
      return desc(products.createdAt);
  }
}

export async function listProductCards(options: {
  categoryIds?: string[];
  query?: string;
  brand?: string;
  preorderOnly?: boolean;
  sort?: ProductSort;
  limit?: number;
  offset?: number;
} = {}): Promise<ProductCard[]> {
  const filters = [publicProductWhere];

  if (options.categoryIds?.length) {
    filters.push(inArray(products.categoryId, options.categoryIds));
  }

  if (options.brand) {
    filters.push(eq(products.brand, options.brand));
  }

  if (options.query) {
    const term = `%${options.query}%`;
    filters.push(
      or(ilike(products.title, term), ilike(products.brand, term))!,
    );
  }

  if (options.preorderOnly) {
    filters.push(eq(products.status, "preorder_open"));
  }

  const rows = await db
    .select(productColumns)
    .from(products)
    .where(and(...filters))
    .orderBy(sortedProductIds(options.sort ?? "relevance"))
    .limit(options.limit ?? 24)
    .offset(options.offset ?? 0);

  return toCards(rows);
}

export async function countProducts(options: {
  categoryIds?: string[];
  query?: string;
} = {}): Promise<number> {
  const filters = [publicProductWhere];

  if (options.categoryIds?.length) {
    filters.push(inArray(products.categoryId, options.categoryIds));
  }

  if (options.query) {
    const term = `%${options.query}%`;
    filters.push(
      or(ilike(products.title, term), ilike(products.brand, term))!,
    );
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(products)
    .where(and(...filters));

  return row.value;
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
      priceBdt: productVariants.priceBdt,
      fulfillmentMode: productVariants.fulfillmentMode,
      stockQuantity: productVariants.stockQuantity,
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
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    )
    .orderBy(asc(productVariants.priceBdt));

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
