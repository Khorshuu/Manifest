import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
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
import { buildProductWhere, publicProductWhere, type ProductFilters } from "./facets";

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

export type ListProductsOptions = ProductFilters & {
  sort?: ProductSort;
  limit?: number;
  offset?: number;
};

export async function listProductCards(
  options: ListProductsOptions = {},
): Promise<ProductCard[]> {
  const rows = await db
    .select(productColumns)
    .from(products)
    .where(await buildProductWhere(options))
    .orderBy(sortedProductIds(options.sort ?? "relevance"))
    .limit(options.limit ?? 24)
    .offset(options.offset ?? 0);

  return toCards(rows);
}

/**
 * Counts exactly what `listProductCards` would return for the same filters.
 * Both go through `buildProductWhere` so the two cannot drift — they did once,
 * and a filtered listing reported more pages than it had.
 */
export async function countProducts(
  filters: ProductFilters = {},
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(products)
    .where(await buildProductWhere(filters));

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

export type Suggestion = {
  kind: "product" | "brand" | "category";
  label: string;
  href: string;
};

/**
 * Autosuggest for the header search.
 *
 * Prefix matches rank above matches inside a word, because someone typing
 * "stu" means "Studio", not "Headphones, studio reference". Nothing here can
 * return a draft or an archived product — it goes through the same public
 * predicate as every other shopper query.
 */
export async function suggestSearch(
  term: string,
  limit = 8,
): Promise<Suggestion[]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const prefix = `${trimmed}%`;
  const anywhere = `%${trimmed}%`;

  const [productRows, brandRows, categoryRows] = await Promise.all([
    db
      .select({ title: products.title, slug: products.slug })
      .from(products)
      .where(and(publicProductWhere, ilike(products.title, anywhere)))
      .orderBy(
        // Prefix first, then alphabetical, so the order is stable rather than
        // whatever the planner returns.
        asc(sql`case when ${products.title} ilike ${prefix} then 0 else 1 end`),
        asc(products.title),
      )
      .limit(limit),

    db
      .selectDistinct({ brand: products.brand })
      .from(products)
      .where(and(publicProductWhere, ilike(products.brand, anywhere)))
      .orderBy(asc(products.brand))
      .limit(4),

    db
      .select({ name: categories.name, slug: categories.slug })
      .from(categories)
      .where(ilike(categories.name, anywhere))
      .orderBy(asc(categories.name))
      .limit(4),
  ]);

  const suggestions: Suggestion[] = [
    ...productRows.map((row) => ({
      kind: "product" as const,
      label: row.title,
      href: `/products/${row.slug}`,
    })),
    ...brandRows
      .filter((row): row is { brand: string } => Boolean(row.brand))
      .map((row) => ({
        kind: "brand" as const,
        label: row.brand,
        href: `/search?q=${encodeURIComponent(row.brand)}`,
      })),
    ...categoryRows.map((row) => ({
      kind: "category" as const,
      label: row.name,
      href: `/categories/${row.slug}`,
    })),
  ];

  return suggestions.slice(0, limit);
}
