import Link from "next/link";
import { FilterForm } from "./filter-form";
import { IconStar } from "./icons";
import type { Facets, FacetValue } from "@/lib/catalog/facets";
import {
  listingHref,
  optionParamName,
  type SearchParamsRecord,
} from "@/lib/catalog/filter-params";
import { formatBdt } from "@/lib/money";

/**
 * The filter panel: a sheet on a phone, a column on a desktop, and a GET form
 * underneath either way.
 *
 * Every group is built from the results in front of the shopper. A brand
 * appears because something in the results is that brand; "RAM" appears
 * because the results carry RAM values — over a page of shoes it does not
 * exist. Counts say what ticking a value would leave, computed against every
 * other filter but not its own group.
 *
 * Dense on purpose. The catalogue will grow and a long list of filters has to
 * stay scannable, so rows are small type at a compact height, groups are
 * separated by a rule rather than by space, and long groups fold behind
 * "Show more". Choosing anything applies at once — there is no Apply button.
 */

export type CategoryFacetView = {
  heading: string;
  /** Somewhere up the tree to go back to, when narrowed. */
  up?: { label: string; href: string } | null;
  /** The shelf currently narrowing the results. */
  current?: string | null;
  items: { label: string; href: string; count: number }[];
};

export type FilterSelection = {
  minTaka: string;
  maxTaka: string;
  fulfillment: string;
  availableOnly: boolean;
  minRating: number | null;
  onSale: boolean;
};

type Props = {
  facets: Facets;
  /** The listing the form submits to. */
  action: string;
  /** The current parameters, for the links that change one of them. */
  params: SearchParamsRecord;
  /** Carried through as hidden fields so filtering keeps the search and sort. */
  hidden?: Record<string, string>;
  total: number;
  hasFilters: boolean;
  clearHref: string;
  categories?: CategoryFacetView | null;
  selected: FilterSelection;
};

/** Values shown before "Show more". */
const VISIBLE = 6;

/*
 * 36px rows on a phone, where a thumb is the pointer; 30px on a desktop,
 * where it is a cursor and the list is long.
 */
const optionRow =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[6px] px-1.5 text-[0.8125rem] leading-tight text-ink transition-colors hover:bg-blue-50 lg:min-h-[1.875rem]";
const linkRow =
  "flex min-h-9 items-center justify-between gap-2 rounded-[6px] px-1.5 text-[0.8125rem] leading-tight transition-colors hover:bg-blue-50 lg:min-h-[1.875rem]";
const legendClass =
  "mb-1 px-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.12em] text-ink/70";
const group = "flex flex-col border-t border-blue-200 pt-3 first:border-t-0 first:pt-0";

function Count({ value }: { value: number }) {
  return (
    <span className="ml-auto shrink-0 pl-2 text-[0.75rem] tabular-nums text-ink/70">
      {value}
    </span>
  );
}

function Checkboxes({ name, values }: { name: string; values: FacetValue[] }) {
  const visible = values.slice(0, VISIBLE);
  const rest = values.slice(VISIBLE);

  const box = (value: FacetValue) => (
    <label key={value.id} className={optionRow}>
      <input
        type="checkbox"
        name={name}
        value={value.id}
        defaultChecked={value.selected}
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{value.label}</span>
      <Count value={value.count} />
    </label>
  );

  return (
    <>
      {visible.map(box)}
      {rest.length > 0 ? (
        <details className="group" open={rest.some((value) => value.selected)}>
          <summary className="flex min-h-8 cursor-pointer list-none items-center px-1.5 text-[0.75rem] font-semibold text-blue-600 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show {rest.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          {rest.map(box)}
        </details>
      ) : null}
    </>
  );
}

function Stars({ count }: { count: number }) {
  return (
    <span aria-hidden="true" className="flex items-center gap-px">
      {[1, 2, 3, 4, 5].map((star) => (
        <IconStar
          key={star}
          size={12}
          className={star <= count ? "fill-brass text-brass" : "text-ink/25"}
        />
      ))}
    </span>
  );
}

function takaBandLabel(minTaka: number | null, maxTaka: number | null): string {
  const taka = (value: number) => formatBdt(value * 100);
  if (minTaka === null && maxTaka !== null) return `Under ${taka(maxTaka)}`;
  if (minTaka !== null && maxTaka === null) return `${taka(minTaka)} and above`;
  return `${taka(minTaka ?? 0)} to ${taka(maxTaka ?? 0)}`;
}

export function FilterPanel({
  facets,
  action,
  params,
  hidden = {},
  total,
  hasFilters,
  clearHref,
  categories,
  selected,
}: Props) {
  const bandSelected = (minTaka: number | null, maxTaka: number | null) =>
    selected.minTaka === (minTaka === null ? "" : String(minTaka)) &&
    selected.maxTaka === (maxTaka === null ? "" : String(maxTaka));

  const matches = `${total.toLocaleString("en-GB")} result${total === 1 ? "" : "s"}`;

  return (
    <FilterForm action={action}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {/*
       * A drawer on a phone, a panel on a desktop, and no JavaScript in
       * either: the control is a real checkbox with a real label. It has no
       * `name`, so it never reaches the query string.
       */}
      <input
        type="checkbox"
        id="filter-drawer"
        className="peer sr-only"
        aria-label="Show filters"
      />

      {/* The ground behind the sheet. Tapping it closes the drawer. */}
      <label
        htmlFor="filter-drawer"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 bg-ink/40 opacity-0 transition-opacity duration-300 peer-checked:pointer-events-auto peer-checked:opacity-100 lg:hidden"
      />

      <div
        /*
         * `invisible` while it is off-screen, and that matters as much as the
         * transform: a panel merely pushed past the bottom of the screen keeps
         * its inputs in the accessibility tree.
         */
        className="invisible fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] translate-y-full flex-col overflow-hidden rounded-t-[var(--radius-media)] border border-blue-300 bg-paper shadow-[var(--shadow-float)] transition-[transform,visibility] duration-300 ease-[var(--ease-out-quint)] peer-checked:visible peer-checked:translate-y-0 lg:visible lg:sticky lg:top-24 lg:z-auto lg:max-h-[calc(100vh-7rem)] lg:translate-y-0 lg:rounded-card lg:shadow-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-blue-200 px-3 py-2">
          <p className="text-[0.8125rem] font-bold text-ink">
            Filters
            {/* The count the listing was built from, for tests and tools. */}
            <span hidden data-result-count={total} />
          </p>
          {hasFilters ? (
            <Link
              href={clearHref}
              className="inline-flex min-h-8 items-center rounded-[6px] px-2 text-[0.75rem] font-semibold text-blue-600 transition-colors hover:bg-blue-50"
            >
              Clear all
            </Link>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-2 py-3">
          {categories && (categories.items.length > 0 || categories.current) ? (
            <nav aria-label={categories.heading} className={group}>
              <p className={legendClass}>{categories.heading}</p>
              {categories.up ? (
                <Link
                  href={categories.up.href}
                  className={`${linkRow} font-semibold text-blue-600`}
                >
                  {categories.up.label}
                </Link>
              ) : null}
              {categories.current ? (
                <p
                  aria-current="true"
                  className="flex min-h-8 items-center px-1.5 text-[0.8125rem] font-bold text-ink"
                >
                  {categories.current}
                </p>
              ) : null}
              <ul className={categories.current ? "pl-2" : ""}>
                {categories.items.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className={`${linkRow} text-ink`}>
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {item.label}
                      </span>
                      <Count value={item.count} />
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <fieldset className={group}>
            <legend className={legendClass}>Availability</legend>

            <label className={optionRow}>
              <input
                type="checkbox"
                name="available"
                value="1"
                defaultChecked={selected.availableOnly}
                className="size-3.5 shrink-0"
              />
              Can be bought now
              <Count value={facets.availability.availableNow} />
            </label>

            {(
              [
                { value: "", label: "Preorder and in stock", count: facets.availability.all },
                { value: "preorder", label: "Preorder only", count: facets.availability.preorder },
                { value: "in_stock", label: "In stock only", count: facets.availability.inStock },
              ] as const
            ).map((option) => (
              <label key={option.value} className={optionRow}>
                <input
                  type="radio"
                  name="fulfillment"
                  value={option.value}
                  defaultChecked={selected.fulfillment === option.value}
                  className="size-3.5 shrink-0"
                />
                {option.label}
                <Count value={option.count} />
              </label>
            ))}

            {facets.availability.onSale > 0 || selected.onSale ? (
              <label className={optionRow}>
                <input
                  type="checkbox"
                  name="deal"
                  value="1"
                  defaultChecked={selected.onSale}
                  className="size-3.5 shrink-0"
                />
                On sale now
                <Count value={facets.availability.onSale} />
              </label>
            ) : null}
          </fieldset>

          {facets.priceRange ? (
            <fieldset className={group}>
              <legend className={legendClass}>Price</legend>

              {facets.priceBands.length > 0 ? (
                <ul>
                  {facets.priceBands.map((band) => {
                    const on = bandSelected(band.minTaka, band.maxTaka);
                    return (
                      <li key={`${band.minTaka}-${band.maxTaka}`}>
                        <Link
                          href={listingHref(action, params, {
                            min: on || band.minTaka === null ? null : String(band.minTaka),
                            max: on || band.maxTaka === null ? null : String(band.maxTaka),
                          })}
                          aria-current={on ? "true" : undefined}
                          className={`${linkRow} ${on ? "bg-blue-50 font-semibold text-blue-600" : "text-ink"}`}
                        >
                          <span>
                            {takaBandLabel(band.minTaka, band.maxTaka)}
                            {on ? <span className="sr-only"> (selected)</span> : null}
                          </span>
                          <Count value={band.count} />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              <div className="mt-1.5 flex items-center gap-1.5 px-1.5">
                <label className="sr-only" htmlFor="filter-min">
                  Lowest price (BDT)
                </label>
                <input
                  id="filter-min"
                  type="number"
                  name="min"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder={String(Math.floor(facets.priceRange.minBdt / 100))}
                  defaultValue={selected.minTaka}
                  className="h-8 w-full min-w-0 rounded-[6px] border border-blue-300 bg-paper px-2 text-[0.8125rem] text-ink"
                />
                <span aria-hidden="true" className="text-[0.75rem] text-ink/70">
                  to
                </span>
                <label className="sr-only" htmlFor="filter-max">
                  Highest price (BDT)
                </label>
                <input
                  id="filter-max"
                  type="number"
                  name="max"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder={String(Math.ceil(facets.priceRange.maxBdt / 100))}
                  defaultValue={selected.maxTaka}
                  className="h-8 w-full min-w-0 rounded-[6px] border border-blue-300 bg-paper px-2 text-[0.8125rem] text-ink"
                />
              </div>
              <p className="mt-1 px-1.5 text-[0.6875rem] text-ink/70">
                Taka. Applies as you type.
              </p>
            </fieldset>
          ) : null}

          {facets.ratings.length > 0 ? (
            <nav aria-label="Customer rating" className={group}>
              <p className={legendClass}>Customer rating</p>
              <ul>
                {facets.ratings.map((rating) => {
                  const on = selected.minRating === rating.min;
                  return (
                    <li key={rating.min}>
                      <Link
                        href={listingHref(action, params, {
                          rating: on ? null : String(rating.min),
                        })}
                        aria-current={on ? "true" : undefined}
                        className={`${linkRow} ${on ? "bg-blue-50 font-semibold" : ""} text-ink`}
                      >
                        <span className="flex items-center gap-1.5">
                          <Stars count={rating.min} />
                          <span>
                            &amp; up
                            {on ? <span className="sr-only"> (selected)</span> : null}
                          </span>
                          <span className="sr-only">{rating.min} stars</span>
                        </span>
                        <Count value={rating.count} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}

          {facets.brands.length > 1 || facets.brands.some((brand) => brand.selected) ? (
            <fieldset className={group}>
              <legend className={legendClass}>Brand</legend>
              <Checkboxes name="brand" values={facets.brands} />
            </fieldset>
          ) : null}

          {facets.attributes.map((attribute) => (
            <fieldset key={attribute.key} className={group}>
              <legend className={legendClass}>{attribute.name}</legend>
              <Checkboxes
                name={optionParamName(attribute.key)}
                values={attribute.values}
              />
            </fieldset>
          ))}

          {/* Enter in a price field still submits with JavaScript off. */}
          <button type="submit" className="sr-only">
            Update results
          </button>
        </div>

        {/* A phone's sheet ends with the running count and a way back to the
            results; there is nothing to apply. */}
        <div className="flex items-center gap-3 border-t border-blue-200 bg-paper px-3 py-2.5 lg:hidden">
          <span className="text-[0.8125rem] tabular-nums text-ink/70">{matches}</span>
          <label
            htmlFor="filter-drawer"
            className="ml-auto inline-flex min-h-10 cursor-pointer items-center rounded-control bg-ink px-4 text-[0.8125rem] font-semibold text-paper"
          >
            Show {matches}
          </label>
        </div>
      </div>
    </FilterForm>
  );
}
