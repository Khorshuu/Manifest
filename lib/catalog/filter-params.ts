import { sql } from "drizzle-orm";
import { queryRows, textArray } from "@/lib/search/sql";
import type { ProductFilters } from "./facets";

/**
 * Filters as they travel in the URL.
 *
 * The URL is the state: a filtered listing can be linked, bookmarked, shared
 * and reloaded, the back button undoes a filter, and the whole panel works with
 * JavaScript switched off because it is an ordinary GET form. Nothing here
 * trusts what arrives — every value is checked before it reaches a query, and
 * anything malformed is dropped rather than passed through to fail in the
 * database.
 *
 * Attribute filters use the attribute's own name as the key, so a shared link
 * reads `/search?q=shirt&size=m&color=black` rather than a list of ids.
 */

export type SearchParamValue = string | string[] | undefined;
export type SearchParamsRecord = Record<string, SearchParamValue>;

/**
 * Parameters with a fixed meaning. Anything else may name an attribute; an
 * attribute whose name collides with one of these travels as `attr-<name>`.
 */
export const RESERVED_PARAMS = new Set([
  "q",
  "sort",
  "page",
  // "spell=0": search for exactly what was typed, without a correction.
  "spell",
  "category",
  "brand",
  "min",
  "max",
  "rating",
  "deal",
  "fulfillment",
  "available",
  "preorder",
  "value",
  "view",
]);

/** The URL parameter an attribute key travels as. */
export function optionParamName(key: string): string {
  return RESERVED_PARAMS.has(key) ? `attr-${key}` : key;
}

/** Repeatable parameters arrive as a string or an array, depending on count. */
function many(value: SearchParamValue): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

/**
 * The current listing with some parameters replaced (`null` removes one), and
 * the page number dropped unless it is one of the changes — a different
 * filter or sort makes the old page number meaningless.
 */
export function listingHref(
  path: string,
  params: SearchParamsRecord,
  changes: Record<string, string | string[] | null> = {},
): string {
  const next = new URLSearchParams();

  for (const [key, raw] of Object.entries(params)) {
    if (key === "page" || key in changes) continue;
    for (const entry of many(raw)) next.append(key, entry);
  }

  for (const [key, value] of Object.entries(changes)) {
    if (value === null) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      next.append(key, entry);
    }
  }

  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ten million taka: far above anything the shop sells, far below an overflow. */
const MAX_TAKA = 10_000_000;

/** Whole taka in the URL, paisa in the database. */
function takaToPaisa(value: SearchParamValue): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_TAKA) {
    return undefined;
  }

  return Math.round(parsed * 100);
}

/** 1 to 4 stars and up. Anything else is not a rating filter. */
export function ratingParam(value: SearchParamValue): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4
    ? parsed
    : undefined;
}

export function parseFilterParams(params: SearchParamsRecord): ProductFilters {
  const fulfillment =
    params.fulfillment === "preorder" || params.fulfillment === "in_stock"
      ? params.fulfillment
      : params.preorder === "1"
        ? ("preorder" as const)
        : undefined;

  const minPriceBdt = takaToPaisa(params.min);
  const maxPriceBdt = takaToPaisa(params.max);

  return {
    // Only well-formed ids reach the query; anything else is dropped rather
    // than passed through to fail in the database.
    valueIds: many(params.value)
      .filter((id) => UUID.test(id))
      .slice(0, 20),
    brands: many(params.brand)
      .map((brand) => brand.trim())
      .filter((brand) => brand.length > 0 && brand.length <= 120)
      .slice(0, 20),
    minPriceBdt,
    // A reversed range is a typo, not a request for nothing.
    maxPriceBdt:
      minPriceBdt !== undefined &&
      maxPriceBdt !== undefined &&
      maxPriceBdt < minPriceBdt
        ? undefined
        : maxPriceBdt,
    fulfillment,
    availableOnly: params.available === "1",
    minRating: ratingParam(params.rating),
    onSale: params.deal === "1",
  };
}

const KEY_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Attribute filters as they arrive: every unreserved parameter shaped like an
 * attribute key. Bounded — twelve keys, twenty values each — so a crafted URL
 * cannot turn one page view into a very large query.
 */
export function optionCandidates(
  params: SearchParamsRecord,
): Record<string, string[]> {
  const options: Record<string, string[]> = {};

  for (const [name, raw] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(name)) continue;

    const key = name.startsWith("attr-") ? name.slice(5) : name;
    if (key.length > 60 || !KEY_SHAPE.test(key)) continue;

    const values = many(raw)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 120)
      .slice(0, 20);
    if (values.length === 0) continue;

    options[key] = [...new Set([...(options[key] ?? []), ...values])];
    if (Object.keys(options).length >= 12) break;
  }

  return options;
}

/**
 * Keeps only the keys that name a real attribute. Without this, an unrelated
 * parameter — a campaign tag, a share-tracking id — would be read as a filter
 * that matches nothing, and a shared link would open on an empty page.
 */
export async function resolveOptionKeys(
  candidates: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const keys = Object.keys(candidates);
  if (keys.length === 0) return {};

  const rows = await queryRows<{ key: string }>(sql`
    select search_slug(name) as key
    from attributes
    where search_slug(name) = any(${textArray(keys)})
    union
    select search_slug(name)
    from category_attributes
    where is_filterable and search_slug(name) = any(${textArray(keys)})
  `);

  const known = new Set(rows.map((row) => row.key));
  return Object.fromEntries(
    Object.entries(candidates).filter(([key]) => known.has(key)),
  );
}

/** Everything a listing URL can say, attribute filters included. */
export async function parseDiscoveryParams(
  params: SearchParamsRecord,
): Promise<ProductFilters> {
  return {
    ...parseFilterParams(params),
    options: await resolveOptionKeys(optionCandidates(params)),
  };
}

/**
 * One removable chip per filter that is actually on.
 *
 * Every chip is an ordinary link back to the same listing with that one
 * parameter dropped, so removing a filter needs no JavaScript and is a real
 * navigation — the back button undoes it, and the URL stays the state.
 *
 * Labels come from what the page already loaded: attribute value ids and
 * attribute keys are named from the facets, a category slug from the tree. No
 * extra query is run to label a chip, and a value the page cannot name gets no
 * chip rather than a chip reading "22222222-…".
 */
export type FilterChip = { key: string; label: string; href: string };

export type OptionChipLabels = Map<
  string,
  { name: string; labels: Map<string, string>; showName?: boolean }
>;

export function activeFilterChips({
  params,
  path,
  valueLabels = new Map(),
  options = new Map(),
  categories = new Map(),
}: {
  params: SearchParamsRecord;
  /** The listing this returns to — "/search", "/categories/coffee". */
  path: string;
  /** Legacy attribute value id to its name, from the page's facets. */
  valueLabels?: Map<string, string>;
  /** Attribute key to its name and its values' labels, from the facets. */
  options?: OptionChipLabels;
  /** Category slug to its name, for the search page's category filter. */
  categories?: Map<string, string>;
}): FilterChip[] {
  const chips: FilterChip[] = [];

  /**
   * The current URL with something taken out: either one value of one
   * repeatable parameter, or a whole set of parameters that a shopper thinks
   * of as a single filter (a price range is two parameters and one chip).
   */
  const without = (names: string[], value?: string) => {
    const next = new URLSearchParams();

    for (const [key, raw] of Object.entries(params)) {
      // A page number no longer means anything once the filters change.
      if (key === "page") continue;
      for (const entry of many(raw)) {
        if (names.includes(key) && (value === undefined || entry === value)) {
          continue;
        }
        next.append(key, entry);
      }
    }

    const query = next.toString();
    return query ? `${path}?${query}` : path;
  };

  const takaLabel = (value: SearchParamValue) =>
    typeof value === "string" ? Number(value).toLocaleString("en-GB") : "";

  const category = typeof params.category === "string" ? params.category : "";
  if (category && categories.has(category)) {
    chips.push({
      key: "category",
      label: `In ${categories.get(category)}`,
      href: without(["category"]),
    });
  }

  for (const brand of many(params.brand)) {
    chips.push({
      key: `brand-${brand}`,
      label: brand,
      href: without(["brand"], brand),
    });
  }

  for (const id of many(params.value)) {
    const label = valueLabels.get(id);
    if (!label) continue;
    chips.push({ key: `value-${id}`, label, href: without(["value"], id) });
  }

  for (const [name, raw] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(name)) continue;
    const key = name.startsWith("attr-") ? name.slice(5) : name;
    const option = options.get(key);
    if (!option) continue;

    for (const value of many(raw)) {
      const label = option.labels.get(value.toLowerCase()) ?? value;
      chips.push({
        key: `option-${key}-${value}`,
        label: option.showName ? `${option.name}: ${label}` : label,
        href: without([name], value),
      });
    }
  }

  const min = takaToPaisa(params.min);
  const max = takaToPaisa(params.max);
  if (min !== undefined || max !== undefined) {
    chips.push({
      key: "price",
      label:
        min !== undefined && max !== undefined
          ? `BDT ${takaLabel(params.min)} – ${takaLabel(params.max)}`
          : min !== undefined
            ? `From BDT ${takaLabel(params.min)}`
            : `Up to BDT ${takaLabel(params.max)}`,
      // Both bounds are one filter to a shopper, so one chip removes both.
      href: without(["min", "max"]),
    });
  }

  const rating = ratingParam(params.rating);
  if (rating !== undefined) {
    chips.push({
      key: "rating",
      label: `${rating} stars & up`,
      href: without(["rating"]),
    });
  }

  if (params.deal === "1") {
    chips.push({ key: "deal", label: "On sale", href: without(["deal"]) });
  }

  if (params.fulfillment === "preorder" || params.preorder === "1") {
    chips.push({
      key: "fulfillment",
      label: "Preorder only",
      href: without(["fulfillment", "preorder"]),
    });
  } else if (params.fulfillment === "in_stock") {
    chips.push({
      key: "fulfillment",
      label: "In stock only",
      href: without(["fulfillment"]),
    });
  }

  if (params.available === "1") {
    chips.push({
      key: "available",
      label: "Available now",
      href: without(["available"]),
    });
  }

  return chips;
}

/** True when anything is actually filtering, for the "clear" affordance. */
export function hasActiveFilters(filters: ProductFilters): boolean {
  return Boolean(
    filters.valueIds?.length ||
      filters.brands?.length ||
      filters.minPriceBdt !== undefined ||
      filters.maxPriceBdt !== undefined ||
      filters.fulfillment ||
      filters.availableOnly ||
      filters.minRating ||
      filters.onSale ||
      Object.values(filters.options ?? {}).some((values) => values.length > 0),
  );
}
