import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { attributeValues, attributes, products } from "@/db/schema";
import { slugify } from "@/lib/search/normalize";
import { planSearch, type SearchPlan } from "@/lib/search/plan";
import { queryRows, searchMatch } from "@/lib/search/sql";
import { effectivePriceExpression } from "./price";
import { PUBLIC_STATUSES } from "./products";

/**
 * Faceted filtering for the listing and search pages.
 *
 * One filter type is shared by the listing query, the count, and every facet
 * count. That is the point: a count built from different conditions than the
 * list it labels is worse than no count, and the two drifted apart before this
 * existed — `countProducts` ignored the brand filter, so page two of a filtered
 * listing could be empty.
 *
 * Facets follow the multi-select rule every large shop uses: a group's counts
 * are computed with every *other* filter applied and its own selections left
 * out, so an unticked brand shows how many it would add rather than zero.
 */

export type ProductFilters = {
  categoryIds?: string[];
  /** An explicit set of products, for a caller that has already chosen them. */
  ids?: string[];
  query?: string;
  /**
   * The search, already planned for this request. Pages plan once and pass it
   * on, so the synonyms are read once rather than once per facet.
   */
  plan?: SearchPlan | null;
  /** Variation value ids, from links written before filters had names. */
  valueIds?: string[];
  /**
   * Attribute filters by URL key — `{ color: ["Black", "White"], ram: ["16"] }`.
   * Values of one key are OR-ed, different keys AND-ed. A key matches a
   * variation attribute or a category specification of the same name, so a
   * shopper sees one "Colour" filter whichever system the value lives in.
   */
  options?: Record<string, string[]>;
  brands?: string[];
  /** Inclusive bounds on a purchasable variant's price, in paisa. */
  minPriceBdt?: number;
  maxPriceBdt?: number;
  /** "preorder" or "in_stock"; empty means both. */
  fulfillment?: "preorder" | "in_stock";
  /** Hides anything with no slot and no stock left. */
  availableOnly?: boolean;
  /** Average approved rating at or above this, 1 to 4. */
  minRating?: number;
  /** Only products with a sale running now. */
  onSale?: boolean;
};

/** A filter group, for leaving one out of its own facet's counts. */
export type FilterGroup =
  | "brand"
  | "category"
  | "price"
  | "rating"
  | "fulfillment"
  | "available"
  | "deal"
  | `option:${string}`;

type Prepared = ProductFilters & {
  plan: SearchPlan | null;
  options: Record<string, string[]>;
};

export const publicProductWhere = and(
  isNull(products.archivedAt),
  inArray(products.status, [...PUBLIC_STATUSES]),
);

/** A purchasable variant, as `v`: enabled, not archived. */
const liveVariant = sql`v.is_enabled = true and v.archived_at is null`;

/** A sale running now on the variant `v`, by the database's clock. */
const saleLive = sql`v.sale_price_bdt is not null
  and v.sale_price_bdt < v.price_bdt
  and (v.sale_starts_at is null or v.sale_starts_at <= now())
  and (v.sale_ends_at is null or v.sale_ends_at > now())`;

/**
 * Something can be bought right now: stock left (or no count kept, which is
 * unlimited — the same rule `stockState` applies), or a preorder slot left with
 * the window still open. Mirrors what the product page decides, so a listing
 * cannot offer what the detail page then refuses.
 */
export const buyableNowSql = sql`exists (
  select 1 from product_variants v
  where v.product_id = ${products.id} and ${liveVariant}
    and (
      (v.fulfillment_mode = 'in_stock'
        and (v.stock_quantity is null or v.stock_quantity > 0))
      or (
        v.fulfillment_mode = 'preorder'
        and (v.preorder_closes_at is null or v.preorder_closes_at > now())
        and (v.preorder_capacity is null or v.preorder_reserved < v.preorder_capacity)
      )
    )
)`;

/** Units sold on orders that were paid for and not unwound. */
export const salesUnitsSql = sql`coalesce((
  select sum(oi.quantity) from order_items oi
  join orders o on o.id = oi.order_id
  join product_variants sv on sv.id = oi.variant_id
  where sv.product_id = ${products.id}
    and o.status not in ('placed', 'cancelled', 'refunded')
), 0)`;

/** Average approved rating, or null when nobody has reviewed it. */
export const ratingAverageSql = sql`(
  select avg(rv.rating) from reviews rv
  where rv.product_id = ${products.id} and rv.status = 'approved'
)`;

/** The deepest discount running now, as a percentage; null when none is. */
export const discountSql = sql`(
  select max((v.price_bdt - v.sale_price_bdt) * 100.0 / nullif(v.price_bdt, 0))
  from product_variants v
  where v.product_id = ${products.id} and ${liveVariant} and ${saleLive}
)`;

/** A purchasable variant priced within the bounds, both on the same variant. */
function priceWithin(minBdt?: number, maxBdt?: number): SQL {
  const price = sql.raw(effectivePriceExpression());
  const bounds: SQL[] = [];
  if (minBdt !== undefined) bounds.push(sql`${price} >= ${minBdt}`);
  if (maxBdt !== undefined) bounds.push(sql`${price} <= ${maxBdt}`);

  return sql`exists (
    select 1 from product_variants v
    where v.product_id = ${products.id} and ${liveVariant}
      ${bounds.length > 0 ? sql`and ${sql.join(bounds, sql` and `)}` : sql``}
  )`;
}

/**
 * An attribute filter: a live variant carrying one of the values, or a
 * specification answered with one of them. Compared case-insensitively, so a
 * hand-typed `?color=black` works as well as the link the panel wrote.
 */
function optionMatches(key: string, values: string[]): SQL {
  const lowered = [...new Set(values.map((value) => value.toLowerCase()))];
  const list = sql.join(
    lowered.map((value) => sql`${value}`),
    sql`, `,
  );

  return sql`(
    exists (
      select 1
      from product_variants v
      join variant_option_values vov on vov.variant_id = v.id
      join attributes a on a.id = vov.attribute_id
      join attribute_values av on av.id = vov.attribute_value_id
      where v.product_id = ${products.id} and ${liveVariant}
        and search_slug(a.name) = ${key}
        and lower(av.value) in (${list})
    )
    or exists (
      select 1
      from category_attributes d
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(${products.attributeValues} -> d.id::text)
          when 'array' then ${products.attributeValues} -> d.id::text
          when 'string' then jsonb_build_array(${products.attributeValues} -> d.id::text)
          when 'number' then jsonb_build_array(${products.attributeValues} -> d.id::text)
          else '[]'::jsonb
        end
      ) as x(value)
      where d.is_filterable
        and search_slug(d.name) = ${key}
        and lower(x.value) in (${list})
    )
  )`;
}

/** Legacy `?value=<id>` links, re-read as named attribute filters. */
async function optionsFromValueIds(
  valueIds: string[],
): Promise<Record<string, string[]>> {
  if (valueIds.length === 0) return {};

  const rows = await db
    .select({ name: attributes.name, value: attributeValues.value })
    .from(attributeValues)
    .innerJoin(attributes, eq(attributes.id, attributeValues.attributeId))
    .where(inArray(attributeValues.id, valueIds));

  const options: Record<string, string[]> = {};
  for (const row of rows) {
    const key = slugify(row.name);
    (options[key] ??= []).push(row.value);
  }
  return options;
}

async function prepare(filters: ProductFilters): Promise<Prepared> {
  const plan =
    filters.plan !== undefined
      ? filters.plan
      : filters.query
        ? await planSearch(filters.query)
        : null;

  const options: Record<string, string[]> = {};
  const merge = (source: Record<string, string[]>) => {
    for (const [key, values] of Object.entries(source)) {
      if (values.length === 0) continue;
      options[key] = [...new Set([...(options[key] ?? []), ...values])];
    }
  };
  merge(filters.options ?? {});
  merge(await optionsFromValueIds(filters.valueIds ?? []));

  return { ...filters, plan, options };
}

/**
 * Every condition a filtered listing applies, optionally without one group —
 * which is how a facet counts against everything but itself.
 */
function conditionsFor(filters: Prepared, omit?: FilterGroup): SQL[] {
  const conditions: SQL[] = [publicProductWhere!];

  if (filters.ids?.length) {
    conditions.push(inArray(products.id, filters.ids));
  }

  if (filters.categoryIds?.length && omit !== "category") {
    conditions.push(inArray(products.categoryId, filters.categoryIds));
  }

  if (filters.brands?.length && omit !== "brand") {
    conditions.push(inArray(products.brand, filters.brands));
  }

  // The search itself is never a facet: every count is within the results.
  if (filters.plan) {
    conditions.push(searchMatch(filters.plan));
  }

  if (filters.fulfillment && omit !== "fulfillment") {
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant}
        and v.fulfillment_mode = ${filters.fulfillment}
    )`);
  }

  if (filters.availableOnly && omit !== "available") {
    conditions.push(buyableNowSql);
  }

  if (
    (filters.minPriceBdt !== undefined || filters.maxPriceBdt !== undefined) &&
    omit !== "price"
  ) {
    conditions.push(priceWithin(filters.minPriceBdt, filters.maxPriceBdt));
  }

  if (filters.minRating && omit !== "rating") {
    conditions.push(sql`${ratingAverageSql} >= ${filters.minRating}`);
  }

  if (filters.onSale && omit !== "deal") {
    conditions.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and ${liveVariant} and ${saleLive}
    )`);
  }

  for (const [key, values] of Object.entries(filters.options)) {
    if (values.length === 0 || omit === `option:${key}`) continue;
    conditions.push(optionMatches(key, values));
  }

  return conditions;
}

/** `product_search` is always joined, so a search condition can read `ps`. */
const searchJoin = {
  table: sql`product_search ps`,
  on: sql`ps.product_id = ${products.id}`,
};

export { searchJoin as productSearchJoin };

export type PreparedFilters = Prepared;

/** Resolves a search and legacy value ids once, for a page that runs many queries. */
export async function prepareFilters(
  filters: ProductFilters,
): Promise<PreparedFilters> {
  return prepare(filters);
}

/** The WHERE for a prepared set of filters. The FROM must join `searchJoin`. */
export function whereFor(filters: PreparedFilters, omit?: FilterGroup): SQL {
  return and(...conditionsFor(filters, omit))!;
}

/** The complete WHERE for a filtered listing, count, or facet count. */
export async function buildProductWhere(
  filters: ProductFilters,
): Promise<SQL | undefined> {
  return whereFor(await prepare(filters));
}

export type FacetValue = {
  /** What goes in the URL. */
  id: string;
  label: string;
  /** Products that would remain if this value were also ticked. */
  count: number;
  selected: boolean;
};

export type AttributeFacet = {
  /** The URL key: "color", "screen-size". */
  key: string;
  name: string;
  values: FacetValue[];
};

export type PriceBand = {
  /** Whole taka, as the URL carries them. Null for an open end. */
  minTaka: number | null;
  maxTaka: number | null;
  count: number;
};

export type Facets = {
  attributes: AttributeFacet[];
  brands: FacetValue[];
  priceRange: { minBdt: number; maxBdt: number } | null;
  priceBands: PriceBand[];
  /** Listings per category id they are filed in, category filter left out. */
  categoryCounts: Record<string, number>;
  /** Thresholds that would leave something: 4 stars and up, 3, 2, 1. */
  ratings: { min: number; count: number }[];
  availability: {
    all: number;
    preorder: number;
    inStock: number;
    availableNow: number;
    onSale: number;
  };
};

export async function listFacets(filters: ProductFilters): Promise<Facets> {
  const prepared = await prepare(filters);

  const [
    attributeFacets,
    brands,
    priceRange,
    categoryCounts,
    ratings,
    availability,
  ] = await Promise.all([
    optionFacets(prepared),
    brandFacet(prepared),
    priceRangeFor(prepared),
    categoryCountsFor(prepared),
    ratingFacet(prepared),
    availabilityFacet(prepared),
  ]);

  const priceBands = priceRange ? await priceBandsFor(prepared, priceRange) : [];

  return {
    attributes: attributeFacets,
    brands,
    priceRange,
    priceBands,
    categoryCounts,
    ratings,
    availability,
  };
}

type OptionFact = {
  key: string;
  name: string;
  value: string;
  ord: number;
  unit: string | null;
  data_type: string;
  count: number;
};

/**
 * Every attribute value in the results, from both systems: variation options
 * on live variants, and category specifications that are marked as filters.
 * Grouped by the attribute's URL key and the value case-insensitively, and
 * counted by product, so a product whose three variants are all black counts
 * once.
 */
async function optionFacts(
  filters: Prepared,
  omit?: FilterGroup,
): Promise<OptionFact[]> {
  return queryRows<OptionFact>(sql`
    with matching as (
      select ${products.id} as id, ${products.attributeValues} as attribute_values
      from ${products}
      left join product_search ps on ps.product_id = ${products.id}
      where ${whereFor(filters, omit)}
    ),
    facts as (
      select m.id as product_id,
             search_slug(a.name) as key,
             a.name as name,
             av.value as value,
             av.sort_order as ord,
             null::text as unit,
             'select'::text as data_type
      from matching m
      join product_variants v on v.product_id = m.id
        and v.is_enabled = true and v.archived_at is null
      join variant_option_values vov on vov.variant_id = v.id
      join attributes a on a.id = vov.attribute_id
      join attribute_values av on av.id = vov.attribute_value_id
      union all
      select m.id,
             search_slug(d.name),
             d.name,
             x.value,
             coalesce((
               select t.ord::int
               from jsonb_array_elements_text(
                 case when jsonb_typeof(d.options) = 'array' then d.options else '[]'::jsonb end
               ) with ordinality as t(option, ord)
               where t.option = x.value
             ), 1000),
             d.unit,
             d.data_type
      from matching m
      cross join lateral jsonb_each(
        case when jsonb_typeof(m.attribute_values) = 'object'
          then m.attribute_values else '{}'::jsonb end
      ) as e(key, value)
      join category_attributes d on d.id::text = e.key and d.is_filterable
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(e.value)
          when 'array' then e.value
          else jsonb_build_array(e.value)
        end
      ) as x(value)
      where x.value <> ''
    )
    select key,
           min(name) as name,
           min(value) as value,
           min(ord)::int as ord,
           min(unit) as unit,
           min(data_type) as data_type,
           count(distinct product_id)::int as count
    from facts
    where key <> ''
    group by key, lower(value)
  `);
}

/** How a stored value reads as a filter. */
function facetLabel(fact: OptionFact): string {
  if (fact.data_type === "boolean") {
    return fact.value === "true" ? "Yes" : fact.value === "false" ? "No" : fact.value;
  }
  return fact.unit ? `${fact.value} ${fact.unit}` : fact.value;
}

const isNumeric = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));

/**
 * Only filters that mean something for these results: an attribute appears
 * when the results carry at least two of its values (a single value filters
 * nothing), or when a value of it is currently selected and has to stay
 * visible to be unticked. "RAM" is never offered over a page of shoes, because
 * no shoe carries a RAM value.
 */
async function optionFacets(filters: Prepared): Promise<AttributeFacet[]> {
  const selectedKeys = Object.keys(filters.options).filter(
    (key) => filters.options[key].length > 0,
  );

  const [everything, ...ownGroups] = await Promise.all([
    optionFacts(filters),
    ...selectedKeys.map((key) => optionFacts(filters, `option:${key}`)),
  ]);

  const byKey = new Map<string, OptionFact[]>();
  for (const fact of everything) {
    if (selectedKeys.includes(fact.key)) continue;
    byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);
  }
  selectedKeys.forEach((key, index) => {
    byKey.set(
      key,
      ownGroups[index].filter((fact) => fact.key === key),
    );
  });

  const facets: AttributeFacet[] = [];

  for (const [key, facts] of byKey) {
    const selected = new Set(
      (filters.options[key] ?? []).map((value) => value.toLowerCase()),
    );

    const values: FacetValue[] = facts.map((fact) => ({
      id: fact.value,
      label: facetLabel(fact),
      count: fact.count,
      selected: selected.has(fact.value.toLowerCase()),
    }));

    // A selected value the results no longer carry still needs its box, or it
    // could not be unticked.
    for (const value of filters.options[key] ?? []) {
      if (!values.some((entry) => entry.id.toLowerCase() === value.toLowerCase())) {
        values.push({ id: value, label: value, count: 0, selected: true });
      }
    }

    const numeric = facts.length > 0 && facts.every((fact) => isNumeric(fact.value));
    const order = new Map(facts.map((fact) => [fact.value, fact.ord]));
    values.sort((a, b) =>
      numeric
        ? Number(a.id) - Number(b.id)
        : (order.get(a.id) ?? 1000) - (order.get(b.id) ?? 1000) ||
          a.label.localeCompare(b.label),
    );

    if (values.length < 2 && !values.some((value) => value.selected)) continue;

    facets.push({ key, name: facts[0]?.name ?? key, values: values.slice(0, 40) });
  }

  // What is being used first, then what covers the most of the results.
  return facets.sort(
    (a, b) =>
      Number(b.values.some((value) => value.selected)) -
        Number(a.values.some((value) => value.selected)) ||
      b.values.reduce((sum, value) => sum + value.count, 0) -
        a.values.reduce((sum, value) => sum + value.count, 0) ||
      a.name.localeCompare(b.name),
  );
}

async function brandFacet(filters: Prepared): Promise<FacetValue[]> {
  const selected = new Set(filters.brands ?? []);

  const rows = await db
    .select({
      brand: products.brand,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .leftJoin(searchJoin.table, searchJoin.on)
    .where(and(whereFor(filters, "brand"), sql`${products.brand} is not null`))
    .groupBy(products.brand)
    .orderBy(desc(sql`count(*)`), asc(products.brand));

  const values: FacetValue[] = rows
    .filter((row): row is { brand: string; count: number } => Boolean(row.brand))
    .map((row) => ({
      id: row.brand,
      label: row.brand,
      count: row.count,
      selected: selected.has(row.brand),
    }));

  for (const brand of selected) {
    if (!values.some((value) => value.id === brand)) {
      values.push({ id: brand, label: brand, count: 0, selected: true });
    }
  }

  return values;
}

/** The real span of prices in the current results, for the price inputs. */
async function priceRangeFor(
  filters: Prepared,
): Promise<{ minBdt: number; maxBdt: number } | null> {
  const [row] = await db
    .select({
      minBdt: sql<number | null>`min(${sql.raw(effectivePriceExpression())})::int`,
      maxBdt: sql<number | null>`max(${sql.raw(effectivePriceExpression())})::int`,
    })
    .from(products)
    .leftJoin(searchJoin.table, searchJoin.on)
    .innerJoin(
      sql`product_variants v`,
      sql`v.product_id = ${products.id} and ${liveVariant}`,
    )
    .where(whereFor(filters, "price"));

  if (!row || row.minBdt === null || row.maxBdt === null) return null;

  return { minBdt: Number(row.minBdt), maxBdt: Number(row.maxBdt) };
}

/** Round figures a shopper thinks in, in taka. */
const PRICE_EDGES = [
  500, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000,
  50_000, 75_000, 100_000, 150_000, 200_000, 300_000, 500_000,
];

/**
 * Up to five ready-made ranges across the results — "Under BDT 2,000",
 * "BDT 2,000 to 5,000" and so on — built from round figures that fall inside
 * the real span, each with a real count. Ranges that would hold nothing are
 * dropped rather than offered.
 */
async function priceBandsFor(
  filters: Prepared,
  range: { minBdt: number; maxBdt: number },
): Promise<PriceBand[]> {
  const low = range.minBdt / 100;
  const high = range.maxBdt / 100;
  let edges = PRICE_EDGES.filter((edge) => edge > low && edge < high);
  if (edges.length === 0) return [];

  if (edges.length > 4) {
    const step = (edges.length - 1) / 3;
    edges = [0, 1, 2, 3].map((index) => edges[Math.round(index * step)]);
    edges = [...new Set(edges)];
  }

  const bands: { minTaka: number | null; maxTaka: number | null }[] = [
    { minTaka: null, maxTaka: edges[0] },
    ...edges.slice(1).map((edge, index) => ({ minTaka: edges[index], maxTaka: edge })),
    { minTaka: edges[edges.length - 1], maxTaka: null },
  ];

  const columns = Object.fromEntries(
    bands.map((band, index) => [
      `b${index}`,
      sql<number>`count(*) filter (where ${priceWithin(
        band.minTaka === null ? undefined : band.minTaka * 100,
        band.maxTaka === null ? undefined : band.maxTaka * 100,
      )})::int`,
    ]),
  );

  const [row] = await db
    .select(columns)
    .from(products)
    .leftJoin(searchJoin.table, searchJoin.on)
    .where(whereFor(filters, "price"));

  return bands
    .map((band, index) => ({
      ...band,
      count: Number((row as Record<string, number>)[`b${index}`] ?? 0),
    }))
    .filter((band) => band.count > 0);
}

async function categoryCountsFor(
  filters: Prepared,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      categoryId: products.categoryId,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .leftJoin(searchJoin.table, searchJoin.on)
    .where(whereFor(filters, "category"))
    .groupBy(products.categoryId);

  return Object.fromEntries(rows.map((row) => [row.categoryId, Number(row.count)]));
}

/**
 * How many results clear each rating threshold. Empty when nothing in the
 * results has been reviewed — a rating filter over unrated products would
 * offer four ways to get an empty page.
 */
async function ratingFacet(
  filters: Prepared,
): Promise<{ min: number; count: number }[]> {
  const [row] = await queryRows<Record<string, number>>(sql`
    with matching as (
      select ${products.id} as id
      from ${products}
      left join product_search ps on ps.product_id = ${products.id}
      where ${whereFor(filters, "rating")}
    )
    select
      count(*) filter (where r.average >= 4)::int as r4,
      count(*) filter (where r.average >= 3)::int as r3,
      count(*) filter (where r.average >= 2)::int as r2,
      count(*) filter (where r.average >= 1)::int as r1
    from matching m
    left join lateral (
      select avg(rv.rating)::float8 as average
      from reviews rv
      where rv.product_id = m.id and rv.status = 'approved'
    ) r on true
  `);

  if (!row || Number(row.r1) === 0) return [];

  return [4, 3, 2, 1]
    .map((min) => ({ min, count: Number(row[`r${min}`] ?? 0) }))
    .filter((entry) => entry.count > 0);
}

async function availabilityFacet(
  filters: Prepared,
): Promise<Facets["availability"]> {
  const count = (where: SQL, filter?: SQL) =>
    db
      .select({
        value: filter
          ? sql<number>`count(*) filter (where ${filter})::int`
          : sql<number>`count(*)::int`,
      })
      .from(products)
      .leftJoin(searchJoin.table, searchJoin.on)
      .where(where);

  const modeExists = (mode: "preorder" | "in_stock") => sql`exists (
    select 1 from product_variants v
    where v.product_id = ${products.id} and ${liveVariant}
      and v.fulfillment_mode = ${mode}
  )`;

  const [all, preorder, inStock, availableNow, onSale] = await Promise.all([
    count(whereFor(filters, "fulfillment")),
    count(whereFor(filters, "fulfillment"), modeExists("preorder")),
    count(whereFor(filters, "fulfillment"), modeExists("in_stock")),
    count(whereFor(filters, "available"), buyableNowSql),
    count(
      whereFor(filters, "deal"),
      sql`exists (
        select 1 from product_variants v
        where v.product_id = ${products.id} and ${liveVariant} and ${saleLive}
      )`,
    ),
  ]);

  return {
    all: Number(all[0]?.value ?? 0),
    preorder: Number(preorder[0]?.value ?? 0),
    inStock: Number(inStock[0]?.value ?? 0),
    availableNow: Number(availableNow[0]?.value ?? 0),
    onSale: Number(onSale[0]?.value ?? 0),
  };
}

/**
 * Which sort orders the catalogue can honestly offer. "Best selling" needs a
 * paid order to exist, "Customer rating" an approved review, "Biggest
 * discount" a sale running now — offering any of them without the data would
 * be a control that sorts by nothing (docs/BUSINESS_LOGIC.md).
 */
export async function sortSignals(): Promise<{
  sales: boolean;
  ratings: boolean;
  discounts: boolean;
}> {
  const [row] = await queryRows<{
    sales: boolean;
    ratings: boolean;
    discounts: boolean;
  }>(sql`
    select
      exists (
        select 1 from orders o where o.status not in ('placed', 'cancelled', 'refunded')
      ) as sales,
      exists (select 1 from reviews r where r.status = 'approved') as ratings,
      exists (
        select 1 from product_variants v
        where ${liveVariant} and ${saleLive}
      ) as discounts
  `);

  return {
    sales: Boolean(row?.sales),
    ratings: Boolean(row?.ratings),
    discounts: Boolean(row?.discounts),
  };
}
