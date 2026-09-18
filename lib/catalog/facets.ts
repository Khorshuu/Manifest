import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { attributeValues, attributes, products } from "@/db/schema";
import { slugify } from "@/lib/search/normalize";
import { planSearch, type SearchPlan } from "@/lib/search/plan";
import { queryRows, searchMatch, textArray } from "@/lib/search/sql";
import { termKey } from "@/lib/search/terms";
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
        and v.preorder_closes_at > now()
        and v.preorder_reserved < v.preorder_capacity
      )
    )
)`;

/**
 * Units sold on orders that were paid for and not unwound.
 *
 * Read from the listing read model (migration 0026), which triggers keep equal
 * to the order lines it summarises. Summing order history per product on every
 * listing cost 532 ms for the whole catalogue sorted by best selling at
 * 100,000 orders; this is one primary-key lookup per product.
 */
export const salesUnitsSql = sql`coalesce((
  select pls.units_sold from product_listing_stats pls
  where pls.product_id = ${products.id}
), 0)`;

/** Average approved rating, or null when nobody has reviewed it (migration 0026). */
export const ratingAverageSql = sql`(
  select pls.rating_avg from product_listing_stats pls
  where pls.product_id = ${products.id}
)`;

/** Approved reviews, from the same read model; 0 when there are none. */
export const reviewCountSql = sql`coalesce((
  select pls.review_count from product_listing_stats pls
  where pls.product_id = ${products.id}
), 0)`;

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
 * An attribute filter, against the facet read model (D-090).
 *
 * The read model already holds one row per product, attribute and normalized
 * value, whether the value came from the knowledge base or from an option
 * group the knowledge base has not mapped yet — so this is one indexed lookup
 * instead of two correlated subqueries over JSON.
 *
 * Both the attribute and the value are matched on their canonical key *or* on
 * the older keys they used to travel under, which is what keeps a link someone
 * shared last month working after "Color" and "Colour" became one filter and
 * "256GB" and "256 GB" became one value.
 */
function optionMatches(key: string, values: string[]): SQL {
  const keys = textArray([...new Set([termKey(key), key])].filter(Boolean));
  const valueKeys = textArray([
    ...new Set(values.map((value) => termKey(value)).filter(Boolean)),
  ]);

  return sql`exists (
    select 1
    from product_search_attributes sa
    where sa.product_id = ${products.id}
      and sa.filterable
      and (sa.url_key = ${key} or sa.alt_keys && ${keys})
      and (sa.value_key = any(${valueKeys}) or sa.value_alt_keys && ${valueKeys})
  )`;
}

/**
 * The attribute and value keys a set of URL filters name (D-090).
 *
 * A filter arrives as whatever the link says: the key the attribute goes by
 * today, one it went by before, and a value spelled any of the ways the
 * catalogue spells it. This resolves each pair to the one key and the one
 * value key the read model holds, so everything downstream — the WHERE, the
 * counts, and which boxes are ticked — compares one thing rather than several
 * spellings of it.
 *
 * A pair nothing recognises is kept as it arrived. It will match nothing,
 * which is right, but it still gets its box and its chip so it can be removed.
 */
async function canonicaliseOptions(
  options: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const pairs: { key: string; value: string }[] = [];
  for (const [key, values] of Object.entries(options)) {
    for (const value of values) {
      const valueKey = termKey(value);
      if (valueKey) pairs.push({ key: termKey(key) ? key : key, value: valueKey });
    }
  }
  if (pairs.length === 0) return {};

  const rows = await queryRows<{
    asked_key: string;
    asked_value: string;
    url_key: string;
    value_key: string;
  }>(sql`
    with asked(k, v) as (values ${sql.join(
      pairs.map((pair) => sql`(${pair.key}::text, ${pair.value}::text)`),
      sql`, `,
    )})
    select a.k as asked_key, a.v as asked_value, sa.url_key, sa.value_key
    from asked a
    join product_search_attributes sa
      on sa.filterable
     and (sa.url_key = a.k or sa.alt_keys @> array[a.k])
     and (sa.value_key = a.v or sa.value_alt_keys @> array[a.v])
    group by a.k, a.v, sa.url_key, sa.value_key
  `);

  const resolved: Record<string, string[]> = {};
  const add = (key: string, value: string) => {
    const list = (resolved[key] ??= []);
    if (!list.includes(value)) list.push(value);
  };

  const matched = new Set<string>();
  for (const row of rows) {
    matched.add(`${row.asked_key} ${row.asked_value}`);
    add(row.url_key, row.value_key);
  }
  for (const pair of pairs) {
    if (!matched.has(`${pair.key} ${pair.value}`)) add(pair.key, pair.value);
  }

  return resolved;
}

/**
 * A brand filter. Brands are compared by their key, so the several spellings
 * the knowledge base has reconciled into one brand entity answer to each
 * other's links (finding F10) and a link written before the reconciliation
 * still opens the right page.
 */
function brandMatches(brands: string[]): SQL {
  const keys = textArray([
    ...new Set(brands.map((brand) => termKey(brand)).filter(Boolean)),
  ]);
  return sql`(
    coalesce(ps.brand_key, '') = any(${keys})
    or exists (
      select 1 from product_search_attributes sa
      where sa.product_id = ${products.id} and sa.url_key = 'brand'
        and (sa.value_key = any(${keys}) or sa.value_alt_keys && ${keys})
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

  return { ...filters, plan, options: await canonicaliseOptions(options) };
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
    conditions.push(brandMatches(filters.brands));
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
  /** The canonical URL key: "color", "screen-size". */
  key: string;
  /**
   * Keys this same filter used to travel under, before the knowledge base
   * reconciled the spellings. A link written under one of them still names
   * this filter, and still gets a chip.
   */
  altKeys: string[];
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
  value_key: string;
  ord: number;
  number: string | null;
  data_type: string;
  count: number;
  alt_keys: string[];
};

/**
 * Every attribute value in the results, from the facet read model (D-090).
 *
 * One indexed read instead of the two correlated subqueries over JSON this
 * used to be. The read model already decided what an attribute is called, what
 * its values compare as, and whether it is a filter at all — which is what
 * makes "Color" and "Colour" one group (finding F12) and "256GB" and "256 GB"
 * one value (finding F11). Counted by product, so a listing whose three
 * variants are all black counts once.
 *
 * The brand is left out: it has a control of its own, and offering it twice
 * would be two filters for one thing.
 */
async function optionFacts(
  filters: Prepared,
  omit?: FilterGroup,
): Promise<OptionFact[]> {
  return queryRows<OptionFact>(sql`
    with matching as (
      select ${products.id} as id
      from ${products}
      left join product_search ps on ps.product_id = ${products.id}
      where ${whereFor(filters, omit)}
    )
    select sa.url_key as key,
           min(sa.label) as name,
           min(sa.value_label) as value,
           sa.value_key as value_key,
           min(sa.sort_order)::int as ord,
           min(sa.value_number) as number,
           min(sa.data_type) as data_type,
           count(distinct sa.product_id)::int as count,
           coalesce(
             (array_agg(distinct alt.key) filter (where alt.key is not null)),
             '{}'::text[]
           ) as alt_keys
    from matching m
    join product_search_attributes sa on sa.product_id = m.id
    left join lateral unnest(sa.alt_keys) as alt(key) on true
    where sa.filterable and sa.url_key <> 'brand'
    group by sa.url_key, sa.value_key
  `);
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
    // Values are compared by their key, not their spelling, so a link written
    // when the value read "256GB" still ticks the box now labelled "256 GB".
    const selected = new Set(
      (filters.options[key] ?? []).map((value) => termKey(value)),
    );

    const values: FacetValue[] = facts.map((fact) => ({
      id: fact.value,
      label: fact.value,
      count: fact.count,
      selected: selected.has(fact.value_key),
    }));

    // A selected value the results no longer carry still needs its box, or it
    // could not be unticked.
    const shown = new Set(facts.map((fact) => fact.value_key));
    for (const value of filters.options[key] ?? []) {
      if (!shown.has(termKey(value))) {
        values.push({ id: value, label: value, count: 0, selected: true });
      }
    }

    // A quantity sorts by what it measures, not by how it reads: 1 TB comes
    // after 512 GB because the knowledge base knows both in bytes.
    const numeric =
      facts.length > 0 &&
      (facts.every((fact) => fact.number !== null) ||
        facts.every((fact) => isNumeric(fact.value)));
    const magnitude = new Map(
      facts.map((fact) => [
        fact.value,
        fact.number !== null ? Number(fact.number) : Number(fact.value),
      ]),
    );
    const order = new Map(facts.map((fact) => [fact.value, fact.ord]));
    values.sort((a, b) =>
      numeric
        ? (magnitude.get(a.id) ?? 0) - (magnitude.get(b.id) ?? 0)
        : (order.get(a.id) ?? 1000) - (order.get(b.id) ?? 1000) ||
          a.label.localeCompare(b.label),
    );

    if (values.length < 2 && !values.some((value) => value.selected)) continue;

    facets.push({
      key,
      altKeys: [...new Set(facts.flatMap((fact) => fact.alt_keys ?? []))].filter(
        (alt) => alt !== key,
      ),
      name: facts[0]?.name ?? key,
      values: values.slice(0, 40),
    });
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

/**
 * Brands in the current results, grouped by the knowledge base's brand entity
 * rather than by the exact string on each listing (finding F10). Two listings
 * that spell one brand differently now count once, under the name the
 * knowledge base holds; a listing whose brand the knowledge base has not
 * reconciled still appears under its own spelling.
 */
async function brandFacet(filters: Prepared): Promise<FacetValue[]> {
  const selected = new Set((filters.brands ?? []).map((brand) => termKey(brand)));

  const rows = await queryRows<{ key: string; label: string; count: number }>(sql`
    with matching as (
      select ${products.id} as id, ${products.brand} as brand
      from ${products}
      left join product_search ps on ps.product_id = ${products.id}
      where ${whereFor(filters, "brand")}
    )
    select
      coalesce(nullif(sa.value_key, ''), search_term_key(m.brand)) as key,
      min(coalesce(sa.value_label, m.brand)) as label,
      count(distinct m.id)::int as count
    from matching m
    left join product_search_attributes sa
      on sa.product_id = m.id and sa.url_key = 'brand'
    where coalesce(nullif(sa.value_key, ''), search_term_key(m.brand)) <> ''
    group by 1
    order by count(distinct m.id) desc, min(coalesce(sa.value_label, m.brand))
  `);

  const values: FacetValue[] = rows.map((row) => ({
    id: row.label,
    label: row.label,
    count: Number(row.count),
    selected: selected.has(row.key),
  }));

  const shown = new Set(rows.map((row) => row.key));
  for (const brand of filters.brands ?? []) {
    if (!shown.has(termKey(brand))) {
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
