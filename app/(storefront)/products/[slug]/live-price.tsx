"use client";

import { useEffect, useState } from "react";
import { formatBdt } from "@/lib/money";

export type LivePriceFigure = {
  priceBdt: number;
  listPriceBdt: number;
  discountPercent: number | null;
};

/**
 * The price beside the title on a phone (D-047).
 *
 * The buy box further down still states the full terms; this is the figure a
 * shopper reads with the name, as in the owner's reference. It follows the
 * option chosen in the picker, and until one is chosen it says "From" the
 * cheapest, the same rule the buy box uses.
 *
 * It is given only the cheapest figure. The chosen variant's figure arrives
 * with the picker's selection event, so a product with hundreds of variants
 * does not send every price twice (PRODUCTION-READINESS 13.1).
 */
export function LivePrice({
  cheapest,
  single,
}: {
  cheapest: LivePriceFigure | null;
  /** One variant only: its price is the price, not a "From". */
  single: boolean;
}) {
  const [selected, setSelected] = useState<LivePriceFigure | null>(single ? cheapest : null);

  useEffect(() => {
    const onVariant = (event: Event) => {
      const detail = (event as CustomEvent<Partial<LivePriceFigure> & { variantId?: string }>).detail;
      if (detail?.variantId && typeof detail.priceBdt === "number" && typeof detail.listPriceBdt === "number") {
        setSelected({
          priceBdt: detail.priceBdt,
          listPriceBdt: detail.listPriceBdt,
          discountPercent: detail.discountPercent ?? null,
        });
      }
    };
    window.addEventListener("product:variant-selected", onVariant);
    return () => window.removeEventListener("product:variant-selected", onVariant);
  }, []);

  const shown = selected ?? cheapest;
  if (!shown) return null;

  return (
    <p className="shrink-0 text-right leading-tight">
      {selected ? null : (
        <span className="block text-[0.6875rem] font-semibold text-ink/70">From</span>
      )}
      <span className="block text-[1.1875rem] font-extrabold tabular-nums tracking-[-0.01em] text-ink">
        {formatBdt(shown.priceBdt)}
      </span>
      {shown.discountPercent !== null ? (
        <span className="block text-meta tabular-nums text-ink/70 line-through">
          <span className="sr-only">Regular price </span>
          {formatBdt(shown.listPriceBdt)}
        </span>
      ) : null}
    </p>
  );
}
