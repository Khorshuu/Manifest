import type { ProductFilters } from "./facets";

/**
 * Filters as they travel in the URL.
 *
 * The URL is the state: a filtered listing can be linked, bookmarked, shared
 * and reloaded, and the whole panel works with JavaScript switched off because
 * it is an ordinary GET form. Nothing here trusts what arrives — every value is
 * checked before it reaches a query.
 */

export type SearchParamValue = string | string[] | undefined;
export type SearchParamsRecord = Record<string, SearchParamValue>;

/** Repeatable parameters arrive as a string or an array, depending on count. */
function many(value: SearchParamValue): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whole taka in the URL, paisa in the database. */
function takaToPaisa(value: SearchParamValue): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return Math.round(parsed * 100);
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
    valueIds: many(params.value).filter((id) => UUID.test(id)),
    brands: many(params.brand),
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
  };
}

/**
 * One removable chip per filter that is actually on.
 *
 * Every chip is an ordinary link back to the same listing with that one
 * parameter dropped, so removing a filter needs no JavaScript and is a real
 * navigation — the back button undoes it, and the URL stays the state.
 *
 * Attribute values arrive as ids; their names come from the facets the page
 * already loaded, so no extra query is run to label a chip.
 */
export type FilterChip = { key: string; label: string; href: string };

export function activeFilterChips({
  params,
  path,
  valueLabels,
}: {
  params: SearchParamsRecord;
  /** The listing this returns to — "/search", "/categories/coffee". */
  path: string;
  /** Attribute value id to its name, from the page's facets. */
  valueLabels: Map<string, string>;
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
      filters.availableOnly,
  );
}
