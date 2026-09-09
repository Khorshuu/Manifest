import { IconChevronDown } from "./icons";
import type { Facets } from "@/lib/catalog";
import { formatBdt } from "@/lib/money";

type Props = {
  facets: Facets;
  /** Current values, so the form comes back filled in. */
  selected: {
    minTaka: string;
    maxTaka: string;
    fulfillment: string;
    availableOnly: boolean;
    sort: string;
  };
  /** Where the form submits — the listing it filters. */
  action: string;
  /** Carried through as hidden fields so filtering does not lose the search. */
  hidden?: Record<string, string>;
  total: number;
  hasFilters: boolean;
};

/**
 * A plain GET form. No JavaScript: submitting navigates, the URL carries the
 * state, and the whole thing works on a slow connection where a client-side
 * filter would not have loaded yet (docs/DESIGN_GUIDELINES.md, mobile-first).
 */
export function FilterPanel({
  facets,
  selected,
  action,
  hidden = {},
  total,
  hasFilters,
}: Props) {
  return (
    <form
      method="get"
      action={action}
      // Open on desktop, collapsed on mobile where it would otherwise push the
      // products themselves below the fold.
      className="min-w-0"
      aria-label="Filter products"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="sort" value={selected.sort} />

      {/*
       * A drawer on a phone, a panel on a desktop, and no JavaScript in
       * either.
       *
       * The control is a real checkbox with a real label: ticking it slides
       * the sheet up from the bottom of the screen, and above `lg` the sheet
       * is simply the panel, sitting in the page with the control hidden. A
       * `<details>` cannot do both — its open state is one value for every
       * viewport, so it is either a sheet already open on arrival or a panel
       * closed on a desktop. The checkbox has no `name`, so it never reaches
       * the query string.
       */}
      <input
        type="checkbox"
        id="filter-drawer"
        className="peer sr-only"
        aria-label="Show filters"
      />

      <label
        htmlFor="filter-drawer"
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-card border border-blue-300 bg-paper px-4 text-body font-semibold text-ink shadow-[var(--shadow-raise)] transition-colors hover:border-blue-500 lg:hidden"
      >
        <span className="flex items-center gap-2">
          Filters
          {hasFilters ? (
            <span className="rounded-control border border-brass px-1.5 py-0.5 text-meta font-bold text-brass-text">
              on
            </span>
          ) : null}
        </span>
        <IconChevronDown size={18} className="shrink-0 text-blue-500" />
      </label>

      {/* The ground behind the sheet. Tapping it closes the drawer, which is
          the gesture everyone tries first. */}
      <label
        htmlFor="filter-drawer"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 bg-ink/40 opacity-0 transition-opacity duration-300 peer-checked:pointer-events-auto peer-checked:opacity-100 lg:hidden"
      />

      <div
        /*
         * `invisible` while it is off-screen, and that matters as much as the
         * transform: a panel merely pushed past the bottom of the screen keeps
         * its inputs in the accessibility tree, so a keyboard tabs into a
         * closed drawer and a screen reader reads out a form nobody opened.
         */
        className="invisible fixed inset-x-0 bottom-0 z-50 flex max-h-[82vh] translate-y-full flex-col overflow-hidden rounded-t-[var(--radius-media)] border border-blue-300 bg-paper shadow-[var(--shadow-float)] transition-[transform,visibility] duration-300 ease-[var(--ease-out-quint)] peer-checked:visible peer-checked:translate-y-0 lg:visible lg:static lg:max-h-none lg:translate-y-0 lg:rounded-card lg:shadow-[var(--shadow-raise)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-blue-300 bg-paper-raised px-4 py-3 lg:py-3">
          <p className="text-body font-semibold text-ink">Filter</p>
          <label
            htmlFor="filter-drawer"
            className="inline-flex min-h-11 cursor-pointer items-center rounded-control px-3 text-meta font-semibold text-blue-600 lg:hidden"
          >
            Done
          </label>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto p-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-meta font-medium text-ink">
              Availability
            </legend>

            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 text-body text-ink transition-colors hover:bg-blue-50">
              <input
                type="checkbox"
                name="available"
                value="1"
                defaultChecked={selected.availableOnly}
              />
              Only what can be bought now
            </label>

            {(
              [
                { value: "", label: "Preorder and in stock" },
                { value: "preorder", label: "Preorder only" },
                { value: "in_stock", label: "In stock only" },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 text-body text-ink transition-colors hover:bg-blue-50"
              >
                <input
                  type="radio"
                  name="fulfillment"
                  value={option.value}
                  defaultChecked={selected.fulfillment === option.value}
                />
                {option.label}
              </label>
            ))}
          </fieldset>

          {facets.priceRange ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-meta font-medium text-ink">Price</legend>
              <p className="text-meta text-ink/70">
                {formatBdt(facets.priceRange.minBdt)} to{" "}
                {formatBdt(facets.priceRange.maxBdt)} in these results
              </p>

              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-meta text-ink">
                  From (BDT)
                  <input
                    type="number"
                    name="min"
                    min={0}
                    inputMode="numeric"
                    defaultValue={selected.minTaka}
                    className="min-h-11 w-32 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                  />
                </label>
                <label className="flex flex-col gap-1 text-meta text-ink">
                  To (BDT)
                  <input
                    type="number"
                    name="max"
                    min={0}
                    inputMode="numeric"
                    defaultValue={selected.maxTaka}
                    className="min-h-11 w-32 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                  />
                </label>
              </div>
            </fieldset>
          ) : null}

          {facets.brands.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-meta font-medium text-ink">Brand</legend>
              {facets.brands.map((brand) => (
                <label
                  key={brand.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 text-body text-ink transition-colors hover:bg-blue-50"
                >
                  <input
                    type="checkbox"
                    name="brand"
                    value={brand.id}
                    defaultChecked={brand.selected}
                  />
                  {brand.label}
                  <span className="text-meta tabular-nums text-ink/70">
                    ({brand.count})
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {facets.attributes.map((attribute) => (
            <fieldset
              key={attribute.attributeId}
              className="flex flex-col gap-2"
            >
              <legend className="text-meta font-medium text-ink">
                {attribute.name}
              </legend>
              {attribute.values.map((value) => (
                <label
                  key={value.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 text-body text-ink transition-colors hover:bg-blue-50"
                >
                  <input
                    type="checkbox"
                    name="value"
                    value={value.id}
                    defaultChecked={value.selected}
                  />
                  {value.label}
                  <span className="text-meta tabular-nums text-ink/70">
                    ({value.count})
                  </span>
                </label>
              ))}
            </fieldset>
          ))}

          {/*
           * On a phone the actions are the sheet's own footer, and the button
           * runs the full width of it — a control the width of its label sits
           * in the bottom corner of the screen, which on this platform is
           * where the browser and the operating system put their own
           * furniture. On a wide screen it is an ordinary row.
           */}
          <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-3 border-t border-blue-300 bg-paper px-4 py-3 lg:static lg:m-0 lg:border-0 lg:p-0">
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] lg:w-auto"
            >
              Apply
            </button>
            {hasFilters ? (
              <a
                href={action}
                className="inline-flex min-h-11 items-center rounded-control px-2 text-body text-blue-600 transition-colors hover:bg-blue-50"
              >
                Clear
              </a>
            ) : null}
            <span className="text-meta tabular-nums text-ink/70">
              {total} match{total === 1 ? "" : "es"}
            </span>
          </div>
        </div>
      </div>
    </form>
  );
}
