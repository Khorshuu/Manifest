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

      <details
        open
        className="group overflow-hidden rounded-card border border-blue-300 bg-paper shadow-[var(--shadow-raise)] md:open"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-paper-raised px-4 py-3 text-body font-medium text-ink transition-colors hover:bg-blue-200/50 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            Filter
            {hasFilters ? (
              <span className="rounded-card border border-brass px-1.5 py-0.5 text-meta font-medium text-brass-text">
                on
              </span>
            ) : null}
          </span>
          {/* The marker rotates with the disclosure, so the control says which
              way it is going rather than only which way it is. */}
          <IconChevronDown
            size={18}
            className="shrink-0 text-blue-500 transition-transform duration-200 group-open:rotate-180"
          />
        </summary>

        <div className="flex flex-col gap-6 border-t border-blue-300 p-4">
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

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]"
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
      </details>
    </form>
  );
}
