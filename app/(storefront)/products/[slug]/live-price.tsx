"use client";

import { useEffect, useState } from "react";
import { formatBdt } from "@/lib/money";

export type LivePriceVariant = {
  id: string;
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
 */
export function LivePrice({ variants }: { variants: LivePriceVariant[] }) {
  const [selectedId, setSelectedId] = useState(
    variants.length === 1 ? variants[0].id : "",
  );

  useEffect(() => {
    const onVariant = (event: Event) => {
      const id = (event as CustomEvent<{ variantId?: string }>).detail?.variantId;
      if (id) setSelectedId(id);
    };
    window.addEventListener("product:variant-selected", onVariant);
    return () => window.removeEventListener("product:variant-selected", onVariant);
  }, []);

  const selected = variants.find((variant) => variant.id === selectedId) ?? null;
  const cheapest = variants.reduce<LivePriceVariant | null>(
    (lowest, variant) =>
      lowest === null || variant.priceBdt < lowest.priceBdt ? variant : lowest,
    null,
  );
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
