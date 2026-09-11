import { sql, type SQL } from "drizzle-orm";
import { productVariants } from "@/db/schema";

/**
 * What a variant actually costs right now.
 *
 * A sale price is only a price while its window is open, and the window is
 * decided by the database's clock rather than by whichever process happens to
 * be rendering — the same reason `isClosed` is computed in SQL. That matters
 * more here than anywhere else on the site: this expression is what the cart
 * reads, what the order is written from, and what the shopper is shown, so all
 * three cannot disagree about whether a sale had started.
 *
 * Every query that reads a price uses one of the two forms below. A query that
 * reached for `price_bdt` directly would quietly charge the pre-sale price.
 */

/** For queries built with the drizzle table objects. */
export const effectivePriceSql: SQL<number> = sql<number>`(case
  when ${productVariants.salePriceBdt} is not null
   and (${productVariants.saleStartsAt} is null or ${productVariants.saleStartsAt} <= now())
   and (${productVariants.saleEndsAt} is null or ${productVariants.saleEndsAt} > now())
  then ${productVariants.salePriceBdt}
  else ${productVariants.priceBdt}
end)`;

/**
 * The same rule as a raw fragment, for the hand-written SQL that joins
 * `product_variants` under an alias. `alias` is only ever a literal written in
 * this repository, never anything that came from a request.
 */
export function effectivePriceExpression(alias = "v"): string {
  return `(case
    when ${alias}.sale_price_bdt is not null
     and (${alias}.sale_starts_at is null or ${alias}.sale_starts_at <= now())
     and (${alias}.sale_ends_at is null or ${alias}.sale_ends_at > now())
    then ${alias}.sale_price_bdt
    else ${alias}.price_bdt
  end)`;
}

export type SalePricing = {
  priceBdt: number;
  salePriceBdt: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
};

/**
 * The same decision in TypeScript, for code that already has the row in hand.
 * `now` is passed in rather than read here so a render stays pure and a test
 * can place itself either side of a sale window.
 */
export function isSaleLive(variant: SalePricing, now: Date): boolean {
  if (variant.salePriceBdt === null) return false;
  if (variant.salePriceBdt >= variant.priceBdt) return false;
  if (variant.saleStartsAt && variant.saleStartsAt > now) return false;
  if (variant.saleEndsAt && variant.saleEndsAt <= now) return false;
  return true;
}

export function effectivePrice(variant: SalePricing, now: Date): number {
  return isSaleLive(variant, now) ? variant.salePriceBdt! : variant.priceBdt;
}

/** Whole percent off, for the "−20%" badge. Null when nothing is off. */
export function discountPercent(
  variant: SalePricing,
  now: Date,
): number | null {
  if (!isSaleLive(variant, now) || variant.priceBdt <= 0) return null;
  const off = Math.round(
    ((variant.priceBdt - variant.salePriceBdt!) / variant.priceBdt) * 100,
  );
  return off > 0 ? off : null;
}

export const STOCK_STATES = [
  "in_stock",
  "low_stock",
  "out_of_stock",
  "preorder",
  "preorder_full",
  "closed",
  "coming_soon",
] as const;
export type StockState = (typeof STOCK_STATES)[number];

/**
 * The one place that decides what a variant's availability is called, so the
 * admin table, the product card and the buy box cannot describe the same
 * variant three different ways.
 */
export function stockState(variant: {
  fulfillmentMode: string;
  stockQuantity: number | null;
  lowStockThreshold: number | null;
  preorderCapacity: number | null;
  preorderReserved: number;
  isClosed?: boolean;
}): StockState {
  if (variant.fulfillmentMode === "preorder") {
    if (variant.isClosed) return "closed";
    const remaining =
      variant.preorderCapacity === null
        ? null
        : Math.max(0, variant.preorderCapacity - variant.preorderReserved);
    return remaining !== null && remaining <= 0 ? "preorder_full" : "preorder";
  }

  // An in-stock variant with no quantity recorded is not "out of stock" — it
  // is unlimited, which is how a made-to-order or digital line behaves.
  if (variant.stockQuantity === null) return "in_stock";
  if (variant.stockQuantity <= 0) return "out_of_stock";
  if (
    variant.lowStockThreshold !== null &&
    variant.stockQuantity <= variant.lowStockThreshold
  ) {
    return "low_stock";
  }
  return "in_stock";
}

export const STOCK_STATE_LABELS: Record<StockState, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  preorder: "Preorder",
  preorder_full: "Preorder full",
  closed: "Preorder closed",
  coming_soon: "Coming soon",
};
