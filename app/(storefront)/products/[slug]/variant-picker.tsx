"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Countdown } from "@/components/countdown";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";

export type PickerVariant = {
  id: string;
  label: string;
  priceBdt: number;
  fulfillmentMode: string;
  remaining: number | null;
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
export function VariantPicker({ variants }: { variants: PickerVariant[] }) {
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

      {variants.length > 1 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta font-medium text-ink">Choose an option</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((variant) => {
              const variantSoldOut =
                variant.remaining !== null && variant.remaining <= 0;
              return (
                <label
                  key={variant.id}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-body ${
                    variant.id === selected.id
                      ? "border-blue-600 text-blue-600"
                      : "border-blue-300 text-ink"
                  } ${variantSoldOut ? "opacity-60" : ""}`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={variant.id}
                    checked={variant.id === selected.id}
                    onChange={() => setSelectedId(variant.id)}
                    className="sr-only"
                  />
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
        <p className="text-h2 font-semibold tabular-nums text-ink">
          {formatBdt(selected.priceBdt)}
        </p>
        <p className="text-meta text-ink/70">
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
            {selected.remaining} slot{selected.remaining === 1 ? "" : "s"} left
          </span>
        ) : null}
      </div>

      {/* The window is the thing a preorder shopper is actually deciding
          about, so it is shown ticking rather than as a date to work out. */}
      {selected.closesAtIso && !closed ? (
        <div className="border-y border-blue-300 py-4">
          <Countdown closesAt={selected.closesAtIso} />
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
          <input
            id="quantity"
            type="number"
            min={1}
            max={selected.remaining ?? 99}
            value={quantity}
            onChange={(event) =>
              setQuantity(Math.max(1, Number(event.target.value) || 1))
            }
            className="min-h-11 w-24 rounded-control border border-blue-300 px-3 text-body tabular-nums"
          />
        </div>

        {/* Wrapped rather than given a `hidden` class: the Button's own
            `inline-flex` sits later in the stylesheet and would win. */}
        <div className="hidden lg:block">
          <Button
            type="button"
            className="transition-transform duration-100 active:scale-[0.98]"
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
          <p className="text-meta text-stamp-red-text">
            {unavailableReason} Join the waitlist and we will tell you when the
            next batch opens.
          </p>
        ) : error ? (
          <p className="text-meta text-stamp-red-text">{error}</p>
        ) : message ? (
          <p className="animate-rise text-meta text-transit-green-text">
            {message}{" "}
            <a href="/cart" className="underline">
              View cart
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
