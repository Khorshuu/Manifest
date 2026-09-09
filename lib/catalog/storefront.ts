import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  categories,
  productImages,
  productVariants,
  products,
  reviews,
  variantOptionValues,
} from "@/db/schema";
import { loadCardAggregates } from "./card-data";
import { searchCondition, searchRank, toTsQuery } from "./search";
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
function sortedProductIds(sort: ProductSort, query?: string) {
  /*
   * "Relevance" means something now. With a search behind it, the best answer
   * first; with no search — a category page, the full catalogue — there is
   * nothing to be relevant to, so it stays newest first.
   */
  if (sort === "relevance" && query?.trim()) {
    return desc(searchRank(query));
  }

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
    .orderBy(sortedProductIds(options.sort ?? "relevance", options.query))
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
  kind: "product" | "brand" | "category" | "search";
  label: string;
  href: string;
  /** Products carry their photograph; nothing else does. */
  thumbnailUrl?: string | null;
  /** A second line — a product's brand, a category's parent. */
  hint?: string | null;
};

/**
 * Autosuggest for the header search.
 *
 * Four kinds of answer, in the order a shopper wants them: the products
 * themselves, the categories that hold them, the brands, and searches worth
 * running that the shopper has not typed. A product matches on everything the
 * listing says about itself, not only its title — the same rule the search
 * page follows, so the dropdown never suggests less than the page would find.
 *
 * Nothing here can return a draft or an archived product; it goes through the
 * same public predicate as every other shopper query. It returns labels,
 * links and a photograph — never a price or a stock level, so this endpoint
 * cannot be used to enumerate the catalogue faster than browsing it.
 */
export async function suggestSearch(
  term: string,
  limit = 8,
): Promise<Suggestion[]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const anywhere = `%${trimmed}%`;
  const matches = searchCondition(trimmed);

  const [productRows, brandRows, categoryRows, tagRows] = await Promise.all([
    db
      .select({ id: products.id, title: products.title, slug: products.slug, brand: products.brand })
      .from(products)
      .where(matches ? and(publicProductWhere, matches) : publicProductWhere)
      // Best answer first, then alphabetically, so equal ranks come back in a
      // stable order rather than whatever the planner happens to return.
      .orderBy(desc(searchRank(trimmed)), asc(products.title))
      .limit(5),

    db
      .selectDistinct({ brand: products.brand })
      .from(products)
      .where(and(publicProductWhere, ilike(products.brand, anywhere)))
      .orderBy(asc(products.brand))
      .limit(3),

    db
      .select({ name: categories.name, slug: categories.slug })
      .from(categories)
      .where(ilike(categories.name, anywhere))
      .orderBy(asc(categories.name))
      .limit(3),

    /*
     * Searches worth running.
     *
     * These are the listing's own tags — words staff filed the product under —
     * so a suggested search always leads somewhere. Inventing phrases would
     * make the dropdown look clever and take shoppers to empty pages.
     */
    toTsQuery(trimmed)
      ? db
          .select({ tag: sql<string>`lower(tag.value)` })
          .from(products)
          .innerJoin(
            sql`jsonb_array_elements_text(${products.tags}) as tag(value)`,
            sql`true`,
          )
          .where(
            and(
              publicProductWhere,
              sql`jsonb_typeof(${products.tags}) = 'array'`,
              sql`tag.value ilike ${anywhere}`,
            ),
          )
          .groupBy(sql`lower(tag.value)`)
          .orderBy(asc(sql`lower(tag.value)`))
          .limit(3)
      : Promise.resolve([] as { tag: string }[]),
  ]);

  const photographs = await loadCardAggregates(
    productRows.map((row) => row.id),
  );

  const suggestions: Suggestion[] = [
    ...productRows.map((row) => ({
      kind: "product" as const,
      label: row.title,
      href: `/products/${row.slug}`,
      thumbnailUrl: photographs.get(row.id)?.imageUrl ?? null,
      hint: row.brand,
    })),
    ...categoryRows.map((row) => ({
      kind: "category" as const,
      label: row.name,
      href: `/categories/${row.slug}`,
    })),
    ...brandRows
      .filter((row): row is { brand: string } => Boolean(row.brand))
      .map((row) => ({
        kind: "brand" as const,
        label: row.brand,
        href: `/search?q=${encodeURIComponent(row.brand)}`,
      })),
    ...tagRows
      // A tag that is simply the word already typed suggests nothing.
      .filter((row) => row.tag && row.tag !== trimmed.toLowerCase())
      .map((row) => ({
        kind: "search" as const,
        label: row.tag,
        href: `/search?q=${encodeURIComponent(row.tag)}`,
      })),
  ];

  return suggestions.slice(0, limit);
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
