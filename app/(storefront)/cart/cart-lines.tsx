"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { ProductArt } from "@/components/product-art";
import { useState } from "react";
import { LinkButton } from "@/components/button";
import {
  IconAlert,
  IconMinus,
  IconPlus,
  IconSeal,
  IconShield,
  IconTag,
  IconClose,
} from "@/components/icons";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";

export type CartLineView = {
  itemId: string;
  productTitle: string;
  productSlug: string;
  optionSummary: string;
  imageUrl: string | null;
  imageAlt: string;
  quantity: number;
  unitPriceBdt: number;
  lineTotalBdt: number;
  problem: string | null;
  fulfillmentMode: string;
  paymentMode: string;
  depositPercent: number | null;
  available: number | null;
};

/**
 * What the price already covers, stated beside the button that spends it.
 *
 * These are the three objections a first-time preorder shopper actually has,
 * and the cart is the last place they can be answered before the form starts.
 */
const ASSURANCES = [
  { icon: IconTag, text: "Shipping and duty are already inside every figure." },
  { icon: IconSeal, text: "Nothing is bought until the batch closes." },
  { icon: IconShield, text: "Full refund until we place the US order." },
];

export function CartLines({
  lines,
  subtotalBdt,
  dueNowBdt,
  hasProblems,
  signedIn = false,
}: {
  lines: CartLineView[];
  subtotalBdt: number;
  dueNowBdt: number;
  hasProblems: boolean;
  /** Save for later keeps the item on the account's wishlist. */
  signedIn?: boolean;
}) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(itemId: string, quantity: number) {
    setPending(itemId);
    setError(null);

    const response = await fetch("/api/cart", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, quantity }),
    });

    setPending(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  async function saveForLater(itemId: string) {
    setPending(itemId);
    setError(null);

    const response = await fetch("/api/cart/save-for-later", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId }),
    });

    setPending(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  const balance = subtotalBdt - dueNowBdt;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12">
      <div className="min-w-0">
        <ul className="flex flex-col gap-4">
          <AnimatePresence initial={false}>
            {lines.map((line) => {
              const busy = pending === line.itemId;
              const max = line.available ?? 99;

              return (
                <motion.li
                  key={line.itemId}
                  layout={reduce ? false : "position"}
                  initial={reduce ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, x: -24, height: 0, marginBottom: 0 }
                  }
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  className={`lift overflow-hidden rounded-card border bg-paper shadow-[var(--shadow-raise)] ${
                    line.problem ? "border-stamp-red" : "border-blue-300"
                  } ${busy ? "opacity-70" : ""}`}
                >
                  <div className="flex flex-wrap items-start gap-4 p-4 sm:gap-5 sm:p-5">
                    <Link
                      href={`/products/${line.productSlug}`}
                      className="media-zoom surface-studio size-24 shrink-0 overflow-hidden rounded-card border border-blue-300 sm:size-28"
                      tabIndex={-1}
                      aria-hidden="true"
                    >
                      {line.imageUrl ? (
                        /* Placeholder media until the storage integration lands. */
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={line.imageUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <ProductArt
                          title={line.productTitle}
                          seed={line.productSlug}
                          className="size-full"
                        />
                      )}
                    </Link>

                    <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
                      <Link
                        href={`/products/${line.productSlug}`}
                        className="link-draw self-start font-display text-h3 leading-snug text-ink"
                      >
                        {line.productTitle}
                      </Link>

                      {/* Only when there is a choice to report: a product with
                          one version should read as its own name (D-043). */}
                      {line.optionSummary ? (
                        <p className="text-meta text-ink/70">
                          {line.optionSummary}
                        </p>
                      ) : null}

                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <StatusBadge
                          tone={
                            line.fulfillmentMode === "preorder"
                              ? "preorder"
                              : "positive"
                          }
                        >
                          {line.fulfillmentMode === "preorder"
                            ? "Preorder"
                            : "In stock"}
                        </StatusBadge>

                        {/* The deposit is the single most surprising thing on a
                            preorder line, so it is named on the line itself
                            rather than only in the total. */}
                        {line.paymentMode === "deposit" &&
                        line.depositPercent !== null ? (
                          <span className="text-meta text-ink/70">
                            {line.depositPercent}% deposit now
                          </span>
                        ) : null}
                      </div>

                      <p className="text-meta tabular-nums text-ink/70">
                        {formatBdt(line.unitPriceBdt)} each
                      </p>

                      {line.problem ? (
                        <p className="mt-1 flex items-start gap-2 text-meta text-stamp-red-text">
                          <IconAlert size={16} className="mt-0.5 shrink-0" />
                          {line.problem}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col items-end gap-3">
                      <p className="font-display text-price font-semibold tabular-nums text-ink">
                        {formatBdt(line.lineTotalBdt)}
                      </p>

                      {/*
                       * A stepper rather than a bare number box. The input is
                       * still there and still typeable — it carries the label
                       * and the value for anyone using a keyboard or a screen
                       * reader — but the two buttons are what a thumb reaches
                       * for, and they commit immediately instead of waiting
                       * for a blur that a phone keyboard makes awkward.
                       */}
                      <div className="flex items-center rounded-control border border-blue-300 bg-paper">
                        <button
                          type="button"
                          onClick={() =>
                            change(line.itemId, Math.max(1, line.quantity - 1))
                          }
                          disabled={busy || line.quantity <= 1}
                          className="inline-flex size-10 items-center justify-center rounded-l-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <IconMinus size={16} />
                          <span className="sr-only">
                            One fewer {line.productTitle}
                          </span>
                        </button>

                        <label
                          htmlFor={`quantity-${line.itemId}`}
                          className="sr-only"
                        >
                          Quantity of {line.productTitle}
                        </label>
                        <input
                          /*
                           * Keyed on the quantity so a server refresh replaces
                           * the box with the true figure, and uncontrolled in
                           * between so a half-typed "1" on the way to "12"
                           * never reaches the API. It commits on blur and on
                           * Enter; the steppers commit immediately.
                           */
                          key={line.quantity}
                          id={`quantity-${line.itemId}`}
                          type="number"
                          min={1}
                          max={max}
                          defaultValue={line.quantity}
                          disabled={busy}
                          onBlur={(event) => {
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next) || next < 1) {
                              event.target.value = String(line.quantity);
                              return;
                            }
                            if (next !== line.quantity) change(line.itemId, next);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                          className="h-10 w-12 border-x border-blue-300 bg-transparent text-center text-body tabular-nums [appearance:textfield] focus:shadow-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />

                        <button
                          type="button"
                          onClick={() => change(line.itemId, line.quantity + 1)}
                          disabled={busy || line.quantity >= max}
                          className="inline-flex size-10 items-center justify-center rounded-r-control text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <IconPlus size={16} />
                          <span className="sr-only">
                            One more {line.productTitle}
                          </span>
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => change(line.itemId, 0)}
                        disabled={busy}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-control px-2 text-meta text-ink/70 transition-colors hover:bg-blue-50 hover:text-stamp-red-text disabled:opacity-60"
                      >
                        <IconClose size={14} />
                        Remove
                      </button>

                      {signedIn ? (
                        <button
                          type="button"
                          onClick={() => saveForLater(line.itemId)}
                          disabled={busy}
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-control px-2 text-meta text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-60"
                        >
                          Save for later
                          <span className="sr-only"> {line.productTitle}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>

        <div aria-live="polite">
          {error ? (
            <p className="mt-4 flex items-center gap-2 text-meta text-stamp-red-text">
              <IconAlert size={16} />
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-6">
          <LinkButton href="/search?available=1" variant="quiet" size="sm">
            Keep browsing
          </LinkButton>
        </div>
      </div>

      <Panel
        as="aside"
        depth="float"
        className="h-fit p-5 sm:p-6 lg:sticky lg:top-28"
      >
        <h2 className="font-display text-h2 text-ink">Summary</h2>

        <dl className="mt-5 flex flex-col gap-3 text-body">
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Subtotal</dt>
            <dd className="tabular-nums text-ink">{formatBdt(subtotalBdt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Shipping and duty</dt>
            <dd className="text-transit-green-text">Included</dd>
          </div>

          <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-blue-300 pt-4">
            <dt className="font-medium text-ink">Due now</dt>
            <dd className="font-display text-h2 font-semibold tabular-nums text-ink">
              {formatBdt(dueNowBdt)}
            </dd>
          </div>
        </dl>

        {balance > 0 ? (
          <p className="mt-3 text-meta text-ink/70">
            The remaining {formatBdt(balance)} is collected once your items are
            bought in the US.
          </p>
        ) : null}

        {/* A blocked checkout says why, on the button's own terms. */}
        {hasProblems ? (
          <p className="mt-4 flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            Fix the flagged items above before checking out.
          </p>
        ) : null}

        <div className="mt-5">
          {hasProblems ? (
            /* A link cannot be disabled, so the blocked state is a real
               button that says why rather than a dead anchor. */
            <button
              type="button"
              disabled
              className="inline-flex min-h-11 w-full cursor-not-allowed items-center justify-center rounded-control border border-blue-300 bg-blue-50 px-5 text-body font-medium text-ink/60"
            >
              Checkout
            </button>
          ) : (
            <LinkButton
              href="/checkout"
              variant="primary"
              size="lg"
              className="w-full"
            >
              Checkout
            </LinkButton>
          )}
        </div>

        <ul className="mt-6 flex flex-col gap-3 border-t border-blue-200 pt-5">
          {ASSURANCES.map(({ icon: Glyph, text }) => (
            <li key={text} className="flex items-start gap-2.5 text-meta text-ink/70">
              <Glyph size={18} className="mt-px shrink-0 text-blue-500" />
              {text}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
