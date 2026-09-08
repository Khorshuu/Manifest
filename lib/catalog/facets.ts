import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeValues,
  attributes,
  productVariants,
  products,
  variantOptionValues,
} from "@/db/schema";
import { PUBLIC_STATUSES } from "./products";

/**
 * Faceted filtering for the listing and search pages.
 *
 * One filter type is shared by the listing query, the count, and the facet
 * counts. That is the point: a count built from different conditions than the
 * list it labels is worse than no count, and the two drifted apart before this
 * existed — `countProducts` ignored the brand filter, so page two of a filtered
 * listing could be empty.
 */

export type ProductFilters = {
  categoryIds?: string[];
  query?: string;
  /** Attribute value ids. Values of the same attribute are OR-ed, different attributes AND-ed. */
  valueIds?: string[];
  brands?: string[];
  /** Inclusive bounds on the lowest purchasable variant price, in paisa. */
  minPriceBdt?: number;
  maxPriceBdt?: number;
  /** "preorder" or "in_stock"; empty means both. */
  fulfillment?: "preorder" | "in_stock";
  /** Hides anything with no slot and no stock left. */
  availableOnly?: boolean;
};

export const publicProductWhere = and(
  isNull(products.archivedAt),
  inArray(products.status, [...PUBLIC_STATUSES]),
);

/** A purchasable variant: enabled, not archived. */
const liveVariant = sql`v.is_enabled = true and v.archived_at is null`;

/**
 * Everything a product's own row can decide, plus subqueries against its
 * variants. Attribute values are handled separately because each attribute
 * needs its own EXISTS.
 */
function baseConditions(filters: ProductFilters): SQL[] {
  const conditions: SQL[] = [publicProductWhere!];

  if (filters.categoryIds?.length) {
    conditions.push(inArray(products.categoryId, filters.categoryIds));
  }

  if (filters.brands?.length) {
    conditions.push(inArray(products.brand, filters.brands));
  }

  if (filters.query) {
    const term = `%${filters.query}%`;
    conditions.push(or(ilike(products.title, term), ilike(products.brand, term))!);
  }

  if (filters.fulfillment) {
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant}
        and v.fulfillment_mode = ${filters.fulfillment}
    )`);
  }

  if (filters.availableOnly) {
    // Something is buyable: stock left, or a preorder slot left and the window
    // still open. Mirrors what the product page decides, so a listing cannot
    // offer what the detail page then refuses.
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant}
        and (
          (v.fulfillment_mode = 'in_stock' and v.stock_quantity > 0)
          or (
            v.fulfillment_mode = 'preorder'
            and (v.preorder_closes_at is null or v.preorder_closes_at > now())
            and (
              v.preorder_capacity is null
              or v.preorder_reserved < v.preorder_capacity
            )
          )
        )
    )`);
  }

  if (filters.minPriceBdt !== undefined) {
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant}
        and v.price_bdt >= ${filters.minPriceBdt}
    )`);
  }

  if (filters.maxPriceBdt !== undefined) {
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant}
        and v.price_bdt <= ${filters.maxPriceBdt}
    )`);
  }

  return conditions;
}

/**
 * Values of one attribute widen the result (red OR blue); values of different
 * attributes narrow it (red AND large). Anything else surprises people: ticking
 * a second colour should not empty the page.
 */
async function attributeConditions(valueIds: string[]): Promise<SQL[]> {
  if (valueIds.length === 0) return [];

  const rows = await db
    .select({ id: attributeValues.id, attributeId: attributeValues.attributeId })
    .from(attributeValues)
    .where(inArray(attributeValues.id, valueIds));

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.attributeId) ?? [];
    existing.push(row.id);
    grouped.set(row.attributeId, existing);
  }

  return [...grouped.values()].map(
    (ids) => sql`exists (
      select 1
      from variant_option_values vov
      join product_variants v on v.id = vov.variant_id
      where v.product_id = ${products.id} and ${liveVariant}
        and vov.attribute_value_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
    )`,
  );
}

/** The complete WHERE for a filtered listing, count, or facet count. */
export async function buildProductWhere(
  filters: ProductFilters,
): Promise<SQL | undefined> {
  const conditions = [
    ...baseConditions(filters),
    ...(await attributeConditions(filters.valueIds ?? [])),
  ];

  return and(...conditions);
}

export type FacetValue = {
  id: string;
  label: string;
  /** Products that would remain if this value were also ticked. */
  count: number;
  selected: boolean;
};

export type AttributeFacet = {
  attributeId: string;
  name: string;
  values: FacetValue[];
};

export type Facets = {
  attributes: AttributeFacet[];
  brands: FacetValue[];
  priceRange: { minBdt: number; maxBdt: number } | null;
};

/**
 * Counts are computed against the other filters but not against the facet's
 * own group, so ticking a second value in the same group shows what it would
 * add rather than always reading zero.
 */
export async function listFacets(filters: ProductFilters): Promise<Facets> {
  const [attributeFacets, brandFacet, priceRange] = await Promise.all([
    attributeFacetsFor(filters),
    brandFacetFor(filters),
    priceRangeFor(filters),
  ]);

  return { attributes: attributeFacets, brands: brandFacet, priceRange };
}

async function attributeFacetsFor(
  filters: ProductFilters,
): Promise<AttributeFacet[]> {
  // Every other filter applies; this facet's own selections do not.
  const otherValueIds = filters.valueIds ?? [];
  const selected = new Set(otherValueIds);

  const rows = await db
    .select({
      attributeId: attributes.id,
      attributeName: attributes.name,
      valueId: attributeValues.id,
      value: attributeValues.value,
      sortOrder: attributeValues.sortOrder,
      productId: products.id,
    })
    .from(attributeValues)
    .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
    .innerJoin(
      variantOptionValues,
      eq(variantOptionValues.attributeValueId, attributeValues.id),
    )
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, variantOptionValues.variantId),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      await buildProductWhere({
        ...filters,
        // Own group excluded, so a second tick in the same group reads as
        // "this many more", not zero.
        valueIds: [],
      }),
    )
    .orderBy(asc(attributes.name), asc(attributeValues.sortOrder));

  const byAttribute = new Map<string, AttributeFacet>();
  const counted = new Map<string, Set<string>>();

  for (const row of rows) {
    let facet = byAttribute.get(row.attributeId);
    if (!facet) {
      facet = {
        attributeId: row.attributeId,
        name: row.attributeName,
        values: [],
      };
      byAttribute.set(row.attributeId, facet);
    }

    let value = facet.values.find((entry) => entry.id === row.valueId);
    if (!value) {
      value = {
        id: row.valueId,
        label: row.value,
        count: 0,
        selected: selected.has(row.valueId),
      };
      facet.values.push(value);
    }

    // One product may have several variants carrying the same value.
    const seen = counted.get(row.valueId) ?? new Set<string>();
    if (!seen.has(row.productId)) {
      seen.add(row.productId);
      counted.set(row.valueId, seen);
      value.count += 1;
    }
  }

  return [...byAttribute.values()];
}

async function brandFacetFor(filters: ProductFilters): Promise<FacetValue[]> {
  const selected = new Set(filters.brands ?? []);

  const rows = await db
    .select({
      brand: products.brand,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .where(
      and(
        await buildProductWhere({ ...filters, brands: [] }),
        sql`${products.brand} is not null`,
      ),
    )
    .groupBy(products.brand)
    .orderBy(asc(products.brand));

  return rows
    .filter((row): row is { brand: string; count: number } =>
      Boolean(row.brand),
    )
    .map((row) => ({
      id: row.brand,
      label: row.brand,
      count: row.count,
      selected: selected.has(row.brand),
    }));
}

/** The real span of prices in the current results, for the price inputs. */
async function priceRangeFor(
  filters: ProductFilters,
): Promise<{ minBdt: number; maxBdt: number } | null> {
  const [row] = await db
    .select({
      minBdt: sql<number | null>`min(v.price_bdt)::int`,
      maxBdt: sql<number | null>`max(v.price_bdt)::int`,
    })
    .from(products)
    .innerJoin(
      sql`product_variants v`,
      sql`v.product_id = ${products.id} and ${liveVariant}`,
    )
    .where(
      await buildProductWhere({
        ...filters,
        minPriceBdt: undefined,
        maxPriceBdt: undefined,
      }),
    );

  if (!row || row.minBdt === null || row.maxBdt === null) return null;

  return { minBdt: row.minBdt, maxBdt: row.maxBdt };
}
