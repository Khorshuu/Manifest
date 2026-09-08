import { formatBdt } from "@/lib/money";

/**
 * What a landed price is made of.
 *
 * Worded to make the point that nothing is being added: the total is the price
 * that was agreed, and these are the parts already inside it. This is the
 * promise the shop is built on — no bill at the door
 * (MASTER_PRODUCT_SPEC.md section 5).
 */
export function LandedBreakdown({
  goodsBdt,
  shippingBdt,
  dutyBdt,
  totalBdt,
}: {
  goodsBdt: number;
  shippingBdt: number;
  dutyBdt: number;
  totalBdt: number;
}) {
  // Older orders were stored before the split existed. Showing a breakdown
  // that is entirely goods would be a lie by omission, so it is left out.
  if (shippingBdt === 0 && dutyBdt === 0) {
    return (
      <div className="flex justify-between gap-4">
        <dt className="text-ink/70">Total</dt>
        <dd className="tabular-nums text-ink">{formatBdt(totalBdt)}</dd>
      </div>
    );
  }

  return (
    <>
      <div className="flex justify-between gap-4">
        <dt className="text-ink/70">Goods</dt>
        <dd className="tabular-nums text-ink">{formatBdt(goodsBdt)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-ink/70">Shipping from the US</dt>
        <dd className="tabular-nums text-ink">{formatBdt(shippingBdt)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-ink/70">Customs duty</dt>
        <dd className="tabular-nums text-ink">{formatBdt(dutyBdt)}</dd>
      </div>
      <div className="flex justify-between gap-4 border-t border-blue-300 pt-2">
        <dt className="font-medium text-ink">Total</dt>
        <dd className="tabular-nums font-medium text-ink">
          {formatBdt(totalBdt)}
        </dd>
      </div>
      <p className="text-meta text-ink/70">
        Shipping and duty are already inside this total. There is nothing more
        to pay on delivery.
      </p>
    </>
  );
}
