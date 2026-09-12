"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, LinkButton } from "@/components/button";
import { CapacityMeter } from "@/components/capacity-meter";
import { Countdown } from "@/components/countdown";
import {
  IconAlert,
  IconCheck,
  IconMinus,
  IconPlus,
  IconSeal,
} from "@/components/icons";
import { StatusBadge } from "@/components/status-badge";
import { WishlistButton } from "@/components/wishlist-button";
import { formatBdt } from "@/lib/money";

/**
 * One word for one state, shared with the admin side through
 * lib/catalog/price.ts — the buy box and the stock table must never describe
 * the same variant differently.
 */
const STOCK_LABELS: Record<string, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  preorder: "Preorder",
  preorder_full: "Full",
  closed: "Closed",
};

export type PickerVariant = {
  id: string;
  label: string;
  /** The variant's own photograph, shown in the gallery when it is chosen. */
  imageUrl: string | null;
  /** What it costs today — a live sale price, or the regular one. */
  priceBdt: number;
  /** The regular price, shown struck through only while a sale is live. */
  listPriceBdt: number;
  /** Whole percent off, or null when nothing is off. */
  discountPercent: number | null;
  /** When the sale ends, if it does. Already formatted. */
  saleEndsLabel: string | null;
  /** in_stock | low_stock | out_of_stock | preorder | preorder_full | closed */
  stockState: string;
  fulfillmentMode: string;
  remaining: number | null;
  /** Every place in the batch, taken or not. Null when nothing is capped. */
  capacity: number | null;
  /**
   * Decided on the server. A client clock can be wrong or deliberately set
   * back, and reading it during render is impure besides.
   */
  isClosed: boolean;
  closesAtLabel: string | null;
  /** ISO, for the live countdown. */
  closesAtIso: string | null;
  arrivalLabel: string | null;
  paymentMode: string;
  depositPercent: number | null;
};

/**
 * Choosing a variant changes price, availability, and the arrival window.
 * Everything a shopper is committing to is stated on this panel — what they
 * are buying, how much is due now, and when it should arrive.
 */
export function VariantPicker({
  variants,
  serverNow,
  signedIn = false,
  savedVariantIds = [],
  returnTo = "/",
}: {
  variants: PickerVariant[];
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
  signedIn?: boolean;
  /** Which of these options the account already has on its wishlist. */
  savedVariantIds?: string[];
  /** Where sign-in brings a guest back to. */
  returnTo?: string;
}) {
  const router = useRouter();
  /*
   * Nothing is chosen for a shopper who has a choice to make (D-043). A
   * product with a single option is that option, so it starts selected; with
   * several, choosing one for them is how somebody buys the wrong colour.
   */
  const [selectedId, setSelectedId] = useState(
    variants.length === 1 ? variants[0].id : "",
  );
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState<"cart" | "buy" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Add to cart, and for Buy now go straight on to checkout. Both send an
   * identifier and a quantity only: the server prices the line, so the buy
   * button cannot be used to name its own price.
   */
  async function addToCart(intent: "cart" | "buy") {
    if (!selected) {
      setMessage(null);
      setError("Please select a variant before continuing.");
      return;
    }

    setPending(intent);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantId: selected.id, quantity }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setPending(null);
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    if (intent === "buy") {
      // Left pending deliberately: the button stays busy until the checkout
      // page has taken over, rather than flashing back to "Buy now".
      router.push("/checkout");
      router.refresh();
      return;
    }

    setPending(null);
    setMessage("Added to your cart.");
    router.refresh();
  }

  const selected = variants.find((v) => v.id === selectedId) ?? null;
  /** What the panel prices before a choice is made: the cheapest option. */
  const cheapest = variants.reduce<PickerVariant | null>(
    (lowest, variant) =>
      lowest === null || variant.priceBdt < lowest.priceBdt ? variant : lowest,
    null,
  );
  /** The option the panel describes — the chosen one, or the cheapest. */
  const shown = selected ?? cheapest;

  if (!shown) {
    return (
      <p className="text-body text-ink/70">
        This product has no options for sale yet.
      </p>
    );
  }

  const soldOut = shown.remaining !== null && shown.remaining <= 0;
  const closed = shown.isClosed;
  const arrival = shown.arrivalLabel;

  const unavailableReason = closed
    ? "This preorder has closed."
    : soldOut
      ? "This preorder is full."
      : null;

  const total = shown.priceBdt * quantity;
  const dueNow =
    shown.paymentMode === "deposit" && shown.depositPercent
      ? Math.round((total * shown.depositPercent) / 100)
      : total;

  /**
   * An unchosen option leaves both buttons live: pressing one is how a shopper
   * finds out a choice is owed, and a disabled button with no explanation is
   * the thing that actually confuses people.
   */
  const blocked = Boolean(unavailableReason);

  const buyLabel = unavailableReason
    ? "Unavailable"
    : pending === "cart"
      ? "Adding…"
      : "Add to cart";

  const buyNowLabel =
    pending === "buy" ? "Taking you to checkout…" : "Buy now";

  return (
    <div className="flex flex-col gap-6">
      {/*
        On a phone the buy button is otherwise far below the fold once the
        options, countdown and details are stacked. This keeps it in reach
        without duplicating any of the logic — it drives the same handler.
      */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-blue-300 bg-paper/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="truncate text-meta text-ink/70">
            {selected ? selected.label : "Choose an option"}
          </p>
          <p className="text-body font-semibold tabular-nums text-ink">
            {selected ? "" : "From "}
            {formatBdt(dueNow)}
          </p>
        </div>
        {/* Both actions stay reachable on a phone: Buy now is the one most
            people want, so it takes the width it needs and Add to cart
            becomes the quieter of the two. */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={blocked || pending !== null}
            onClick={() => addToCart("cart")}
          >
            {pending === "cart" ? "Adding…" : "Add"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={blocked || pending !== null}
            onClick={() => addToCart("buy")}
          >
            {unavailableReason ? "Unavailable" : pending === "buy" ? "…" : "Buy now"}
          </Button>
        </div>
      </div>
      {/* Room for the bar, so it never covers the last line of the page. */}
      <div aria-hidden="true" className="h-16 lg:hidden" />

      {/*
       * The buy box, as one object.
       *
       * Everything from the option chips to the button is a single decision,
       * and it was previously a column of loose rows separated by hairlines —
       * indistinguishable from the description further down the page. Giving
       * it a surface is what tells a shopper where the shop is on this page.
       */}
      <div className="flex flex-col gap-3.5 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
      {variants.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-meta font-medium text-ink">Choose an option</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((variant) => {
              const variantSoldOut =
                variant.remaining !== null && variant.remaining <= 0;
              const chosen = variant.id === selectedId;

              return (
                <label
                  key={variant.id}
                  /* The radio is visually hidden so the chip can be the
                     control, which means the chip has to carry the focus
                     ring itself. */
                  className={`flex min-h-10 cursor-pointer items-center gap-1.5 rounded-control border px-3 text-meta transition-[border-color,background-color,box-shadow] duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brass ${
                    chosen
                      ? "border-blue-600 bg-blue-50 font-medium text-blue-600 shadow-[var(--shadow-raise)]"
                      : "border-blue-300 text-ink hover:border-blue-500 hover:bg-blue-50/60"
                  } ${variantSoldOut ? "opacity-60" : ""}`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={variant.id}
                    checked={chosen}
                    onChange={() => {
                      setSelectedId(variant.id);
                      // The gallery shows this variant's own photo, if it has one.
                      window.dispatchEvent(
                        new CustomEvent("product:variant-selected", { detail: { imageUrl: variant.imageUrl } }),
                      );
                    }}
                    className="sr-only"
                  />
                  {chosen ? (
                    <IconCheck size={14} className="shrink-0" />
                  ) : null}
                  {variant.label}
                  {variantSoldOut ? (
                    <span className="text-meta text-stamp-red-text">Full</span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <p className="text-[1.625rem] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {/* "From" until an option is chosen: the figure is the cheapest
                one, and stating it flatly would misprice the others. */}
            {selected ? null : (
              <span className="mr-1.5 text-body font-semibold text-ink/70">
                From
              </span>
            )}
            {formatBdt(shown.priceBdt)}
          </p>
          {shown.discountPercent !== null ? (
            <>
              {/* The regular price is stated as what it was, not implied by a
                  struck-through number alone — a screen reader reads a
                  line-through as nothing at all. */}
              <p className="text-body tabular-nums text-ink/60 line-through">
                <span className="sr-only">Regular price </span>
                {formatBdt(shown.listPriceBdt)}
              </p>
              <StatusBadge tone="positive">
                Save {shown.discountPercent}%
              </StatusBadge>
            </>
          ) : null}
        </div>
        {shown.saleEndsLabel ? (
          <p className="text-meta text-brass-text">
            Sale price until {shown.saleEndsLabel}.
          </p>
        ) : null}
        <p className="flex items-center gap-1.5 text-[0.75rem] text-transit-green-text">
          <IconSeal size={14} className="shrink-0" />
          Shipping and customs duty included.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <StatusBadge
          tone={
            unavailableReason
              ? "negative"
              : shown.stockState === "low_stock"
                ? "warning"
                : shown.fulfillmentMode === "preorder"
                  ? "preorder"
                  : "positive"
          }
        >
          {STOCK_LABELS[shown.stockState] ??
            (shown.fulfillmentMode === "preorder" ? "Preorder" : "In stock")}
        </StatusBadge>

        {shown.remaining !== null && shown.remaining > 0 ? (
          <span className="text-meta text-ink/70">
            {shown.remaining} place{shown.remaining === 1 ? "" : "s"} left
          </span>
        ) : null}

        {/* The window, ticking, in one line rather than four large tiles. */}
        {shown.closesAtIso && !closed ? (
          <span className="basis-full sm:ml-auto sm:basis-auto">
            <Countdown
              variant="inline"
              closesAt={shown.closesAtIso}
              serverNow={serverNow}
            />
          </span>
        ) : null}
      </div>

      {/*
        The same meter the cards carry, so a shopper who chose this listing off
        a grid sees the same figure presented the same way rather than having to
        re-read it in a different form. "Places", not "slots": one word for one
        thing, everywhere.
      */}
      {shown.fulfillmentMode === "preorder" ? (
        <CapacityMeter
          remaining={shown.remaining}
          total={shown.capacity}
          showLabel={false}
        />
      ) : null}

      <dl className="flex flex-col gap-1 text-meta empty:hidden">
        {arrival ? (
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Expected arrival</dt>
            <dd className="text-ink">{arrival}</dd>
          </div>
        ) : null}
        {shown.paymentMode === "deposit" && shown.depositPercent ? (
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Due now</dt>
            <dd className="text-ink tabular-nums">
              {formatBdt(dueNow)} ({shown.depositPercent}% deposit)
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="quantity" className="text-meta font-medium text-ink/75">
            Qty
          </label>

          {/* The same stepper the cart uses: two thumb-sized buttons around a
              field that is still typeable and still carries the label. */}
          <div className="flex items-center rounded-control border border-blue-300 bg-paper">
            <button
              type="button"
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              disabled={quantity <= 1}
              className="inline-flex size-10 items-center justify-center rounded-l-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconMinus size={16} />
              <span className="sr-only">One fewer</span>
            </button>

            <input
              id="quantity"
              type="number"
              min={1}
              max={shown.remaining ?? 99}
              value={quantity}
              onChange={(event) =>
                setQuantity(Math.max(1, Number(event.target.value) || 1))
              }
              className="h-10 w-12 border-x border-blue-300 bg-transparent text-center text-body tabular-nums [appearance:textfield] focus:shadow-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />

            <button
              type="button"
              onClick={() =>
                setQuantity((current) =>
                  Math.min(shown.remaining ?? 99, current + 1),
                )
              }
              disabled={quantity >= (shown.remaining ?? 99)}
              className="inline-flex size-10 items-center justify-center rounded-r-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconPlus size={16} />
              <span className="sr-only">One more</span>
            </button>
          </div>
        </div>

        {/* Wrapped rather than given a `hidden` class: the Button's own
            `inline-flex` sits later in the stylesheet and would win.

            Buy now is the primary action and Add to cart the quieter one
            beside it — two clear ways to buy, not a cluttered row. */}
        <div className="hidden flex-1 gap-2 lg:flex">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            disabled={blocked || pending !== null}
            onClick={() => addToCart("cart")}
          >
            {buyLabel}
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={blocked || pending !== null}
            onClick={() => addToCart("buy")}
          >
            {unavailableReason ? "Unavailable" : buyNowLabel}
          </Button>
        </div>
      </div>

      {variants.length > 1 && !selected ? (
        <p className="text-meta text-ink/70">
          Choose an option above to see its price and buy it.
        </p>
      ) : null}

      {/* States why, rather than leaving a disabled button unexplained. */}
      <div aria-live="polite">
        {unavailableReason ? (
          <p className="flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            <span>
              {unavailableReason} Join the waitlist and we will tell you when
              the next batch opens.
            </span>
          </p>
        ) : error ? (
          <p className="flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : message ? (
          /* The confirmation an add actually landed, with the way onwards.
             A line of green text was easy to miss on a busy panel. */
          <div className="animate-rise flex flex-wrap items-center justify-between gap-3 rounded-card border border-transit-green bg-transit-green/10 p-3">
            <p className="flex items-center gap-2 text-meta font-medium text-transit-green-text">
              <IconCheck size={16} className="shrink-0" />
              {message}
            </p>
            <LinkButton href="/cart" variant="secondary" size="sm">
              View cart
            </LinkButton>
          </div>
        ) : null}
      </div>

      {/* Keyed on the option, so switching options shows that option's own
          saved state rather than carrying the last one's. A wishlist entry is
          an option, so there is nothing to save until one is chosen. */}
      {selected ? (
        <WishlistButton
          key={selected.id}
          variantId={selected.id}
          initiallySaved={savedVariantIds.includes(selected.id)}
          signedIn={signedIn}
          returnTo={returnTo}
        />
      ) : null}
      </div>
    </div>
  );
}
