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
