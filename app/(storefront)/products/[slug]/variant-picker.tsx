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
import { formatBdt } from "@/lib/money";

export type PickerVariant = {
  id: string;
  label: string;
  priceBdt: number;
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
}: {
  variants: PickerVariant[];
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addToCart(variantId: string) {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Identifier and quantity only — the server prices it.
      body: JSON.stringify({ variantId, quantity }),
    });

    const body = await response.json().catch(() => ({}));
    setPending(false);

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage("Added to your cart.");
    router.refresh();
  }

  const selected = variants.find((v) => v.id === selectedId) ?? variants[0];

  if (!selected) {
    return (
      <p className="text-body text-ink/70">
        This product has no options for sale yet.
      </p>
    );
  }

  const soldOut = selected.remaining !== null && selected.remaining <= 0;
  const closed = selected.isClosed;
  const arrival = selected.arrivalLabel;

  const unavailableReason = closed
    ? "This preorder has closed."
    : soldOut
      ? "This preorder is full."
      : null;

  const total = selected.priceBdt * quantity;
  const dueNow =
    selected.paymentMode === "deposit" && selected.depositPercent
      ? Math.round((total * selected.depositPercent) / 100)
      : total;

  const buyLabel = unavailableReason
    ? "Unavailable"
    : pending
      ? "Adding…"
      : "Add to cart";

  return (
    <div className="flex flex-col gap-6">
      {/*
        On a phone the buy button is otherwise far below the fold once the
        options, countdown and details are stacked. This keeps it in reach
        without duplicating any of the logic — it drives the same handler.
      */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-blue-300 bg-paper/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="truncate text-meta text-ink/70">{selected.label}</p>
          <p className="text-body font-semibold tabular-nums text-ink">
            {formatBdt(dueNow)}
          </p>
        </div>
        <Button
          type="button"
          disabled={Boolean(unavailableReason) || pending}
          onClick={() => addToCart(selected.id)}
        >
          {buyLabel}
        </Button>
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
      <div className="flex flex-col gap-6 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
      {variants.length > 1 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta font-medium text-ink">Choose an option</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((variant) => {
              const variantSoldOut =
                variant.remaining !== null && variant.remaining <= 0;
              const chosen = variant.id === selected.id;

              return (
                <label
                  key={variant.id}
                  /* The radio is visually hidden so the chip can be the
                     control, which means the chip has to carry the focus
                     ring itself. */
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-body transition-[border-color,background-color,box-shadow] duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brass ${
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
                    onChange={() => setSelectedId(variant.id)}
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

      <div className="flex flex-col gap-2">
        <p className="font-display text-h1 font-semibold tabular-nums text-ink">
          {formatBdt(selected.priceBdt)}
        </p>
        <p className="flex items-center gap-2 text-meta text-transit-green-text">
          <IconSeal size={16} className="shrink-0" />
          Shipping and customs duty included.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          tone={
            unavailableReason
              ? "negative"
              : selected.fulfillmentMode === "preorder"
                ? "preorder"
                : "positive"
          }
        >
          {unavailableReason
            ? closed
              ? "Closed"
              : "Full"
            : selected.fulfillmentMode === "preorder"
              ? "Preorder"
              : "In stock"}
        </StatusBadge>

        {selected.remaining !== null && selected.remaining > 0 ? (
          <span className="text-meta text-ink/70">
            {selected.remaining} place{selected.remaining === 1 ? "" : "s"} left
          </span>
        ) : null}
      </div>

      {/*
        The same meter the cards carry, so a shopper who chose this listing off
        a grid sees the same figure presented the same way rather than having to
        re-read it in a different form. "Places", not "slots": one word for one
        thing, everywhere.
      */}
      {selected.fulfillmentMode === "preorder" ? (
        <CapacityMeter
          remaining={selected.remaining}
          total={selected.capacity}
          showLabel={false}
        />
      ) : null}

      {/* The window is the thing a preorder shopper is actually deciding
          about, so it is shown ticking rather than as a date to work out. */}
      {selected.closesAtIso && !closed ? (
        <div className="border-y border-blue-300 py-4">
          <Countdown closesAt={selected.closesAtIso} serverNow={serverNow} />
        </div>
      ) : null}

      <dl className="flex flex-col gap-2 border-b border-blue-300 pb-4 text-meta">
        {arrival ? (
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Expected arrival</dt>
            <dd className="text-ink">{arrival}</dd>
          </div>
        ) : null}
        {selected.paymentMode === "deposit" && selected.depositPercent ? (
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Due now</dt>
            <dd className="text-ink tabular-nums">
              {formatBdt(dueNow)} ({selected.depositPercent}% deposit)
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="quantity" className="text-meta font-medium text-ink">
            Quantity
          </label>

          {/* The same stepper the cart uses: two thumb-sized buttons around a
              field that is still typeable and still carries the label. */}
          <div className="flex items-center rounded-control border border-blue-300 bg-paper">
            <button
              type="button"
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              disabled={quantity <= 1}
              className="inline-flex size-11 items-center justify-center rounded-l-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconMinus size={16} />
              <span className="sr-only">One fewer</span>
            </button>

            <input
              id="quantity"
              type="number"
              min={1}
              max={selected.remaining ?? 99}
              value={quantity}
              onChange={(event) =>
                setQuantity(Math.max(1, Number(event.target.value) || 1))
              }
              className="h-11 w-14 border-x border-blue-300 bg-transparent text-center text-body tabular-nums [appearance:textfield] focus:shadow-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />

            <button
              type="button"
              onClick={() =>
                setQuantity((current) =>
                  Math.min(selected.remaining ?? 99, current + 1),
                )
              }
              disabled={quantity >= (selected.remaining ?? 99)}
              className="inline-flex size-11 items-center justify-center rounded-r-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconPlus size={16} />
              <span className="sr-only">One more</span>
            </button>
          </div>
        </div>

        {/* Wrapped rather than given a `hidden` class: the Button's own
            `inline-flex` sits later in the stylesheet and would win. */}
        <div className="hidden flex-1 lg:block">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={Boolean(unavailableReason) || pending}
            onClick={() => addToCart(selected.id)}
          >
            {buyLabel}
          </Button>
        </div>
      </div>

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
      </div>
    </div>
  );
}
