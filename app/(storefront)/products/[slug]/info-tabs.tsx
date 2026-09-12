"use client";

import { useId, useState } from "react";
import { Highlights, SpecTable, type SpecRow } from "./detail-sections";

/**
 * Description · Specification · Measurements (DECISIONS.md D-043).
 *
 * One place for everything a shopper reads about the product itself, instead
 * of three headings stacked down the page. Description opens first because it
 * is what most people want; Measurements appears only when the listing
 * actually carries measurements, because an empty tab reads as a shop that
 * forgot to fill it in.
 *
 * On a phone the tabs scroll sideways rather than wrapping, so the panel below
 * never jumps as the row rewraps.
 */
export type InfoTabsProps = {
  descriptionHtml: string | null;
  /** Shown under the description — the same lines as "At a glance" above. */
  keyFeatures: string[];
  specifications: SpecRow[];
  measurements: SpecRow[];
};

export function ProductInfoTabs({
  descriptionHtml,
  keyFeatures,
  specifications,
  measurements,
}: InfoTabsProps) {
  const base = useId();

  const tabs = [
    descriptionHtml || keyFeatures.length > 0
      ? { id: "description", label: "Description" }
      : null,
    specifications.length > 0
      ? { id: "specification", label: "Specification" }
      : null,
    measurements.length > 0
      ? { id: "measurements", label: "Measurements" }
      : null,
  ].filter((tab): tab is { id: string; label: string } => tab !== null);

  const [active, setActive] = useState(tabs[0]?.id ?? "description");

  if (tabs.length === 0) return null;

  const current = tabs.some((tab) => tab.id === active) ? active : tabs[0].id;

  return (
    <section id="product-information" className="min-w-0">
      <div
        role="tablist"
        aria-label="Product information"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-blue-300 px-4 md:mx-0 md:px-0"
      >
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${base}-${tab.id}-tab`}
              aria-selected={selected}
              aria-controls={`${base}-${tab.id}-panel`}
              /* Arrow keys move between tabs, which is what a tablist is for;
                 a shopper on a keyboard otherwise has to tab through each. */
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => {
                const index = tabs.findIndex((entry) => entry.id === current);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + tabs.length) % tabs.length
                      : null;
                if (next === null) return;
                event.preventDefault();
                setActive(tabs[next].id);
                document.getElementById(`${base}-${tabs[next].id}-tab`)?.focus();
              }}
              onClick={() => setActive(tab.id)}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-3 text-body font-medium transition-colors sm:px-4 ${
                selected
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-ink/70 hover:border-blue-300 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-${tab.id}-panel`}
          aria-labelledby={`${base}-${tab.id}-tab`}
          hidden={tab.id !== current}
          className="pt-6"
        >
          {tab.id === "description" ? (
            <div className="flex flex-col gap-6">
              {descriptionHtml ? (
                <div
                  className="product-copy max-w-[68ch] text-body text-ink/80"
                  /* Authored by staff only — customers cannot create listings,
                     and generated HTML is reduced to an allow-list before it
                     is ever stored (lib/seo-pulse/sanitize.ts). */
                  dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                />
              ) : null}

              {keyFeatures.length > 0 ? (
                <div className="max-w-[68ch]">
                  <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink/60">
                    Key features
                  </h3>
                  <div className="mt-3">
                    <Highlights items={keyFeatures} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab.id === "specification" ? (
            <SpecTable rows={specifications} />
          ) : null}

          {tab.id === "measurements" ? (
            <div className="flex flex-col gap-3">
              <SpecTable rows={measurements} />
              <p className="text-meta text-ink/60">
                Measurements are as supplied by the manufacturer. Allow for
                small differences between units.
              </p>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
