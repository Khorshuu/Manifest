"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { ProductArt } from "@/components/product-art";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LinkButton } from "@/components/button";
import {
  IconAlert,
  IconMinus,
  IconPlus,
  IconSeal,
  IconShield,
  IconTag,
  IconClose,
  IconTrash,
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

/** How far a row slides to show its bin, and how far a swipe must go. */
const REVEAL = 84;
const COMMIT = 52;

/**
 * A cart row that slides left under a thumb to show a red bin (D-047).
 *
 * The gesture is an extra, never the only way: the stepper's own bin at a
 * quantity of one, and Remove from `sm` up, do the same thing. `touch-action:
 * pan-y` leaves vertical scrolling to the browser, so only a sideways drag
 * reaches this code, and a drag that is mostly vertical is ignored.
 */
function SwipeRow({
  onRemove,
  disabled,
  children,
}: {
  onRemove: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null } | null>(
    null,
  );

  return (
    <div className="relative">
      {/* The bin behind the row. A pointer-only affordance: the row's own
          controls carry the accessible Remove. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled}
        onClick={onRemove}
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-stamp-red/10 text-stamp-red-text sm:hidden"
        style={{ width: REVEAL }}
      >
        <span className="inline-flex size-11 items-center justify-center rounded-full bg-stamp-red/15">
          <IconTrash size={20} />
        </span>
      </button>

      <div
        className={`relative bg-paper [touch-action:pan-y] ${
          dragging ? "" : "transition-transform duration-300 ease-[var(--ease-out-quint)]"
        }`}
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onTouchStart={(event) => {
          if (disabled) return;
          const touch = event.touches[0];
          start.current = { x: touch.clientX, y: touch.clientY, base: offset, axis: null };
        }}
        onTouchMove={(event) => {
          const origin = start.current;
          if (!origin) return;
          const touch = event.touches[0];
          const dx = touch.clientX - origin.x;
          const dy = touch.clientY - origin.y;
          if (origin.axis === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            origin.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          }
          if (origin.axis !== "x") return;
          setDragging(true);
          setOffset(Math.min(0, Math.max(-REVEAL - 24, origin.base + dx)));
        }}
        onTouchEnd={() => {
          const origin = start.current;
          start.current = null;
          setDragging(false);
          if (!origin || origin.axis !== "x") {
            // A tap on an open row closes it rather than following a link.
            return;
          }
          setOffset((current) => (current < -COMMIT ? -REVEAL : 0));
        }}
        onClickCapture={(event) => {
          if (offset !== 0) {
            event.preventDefault();
            event.stopPropagation();
            setOffset(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

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

  // The checkout bar is fixed to the foot of a phone screen; the page makes
  // room for it so the footer's last line is never under it.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.bottomBar = "true";
    return () => {
      delete root.dataset.bottomBar;
    };
  }, []);

  const balance = subtotalBdt - dueNowBdt;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12">
      <div className="min-w-0">
        {/* On a phone the rows sit on a pale ground, edge to edge, as white
            slips with a little space between them (D-047). */}
        <ul className="flex flex-col gap-4 max-sm:-mx-4 max-sm:gap-2 max-sm:bg-paper-raised max-sm:px-3 max-sm:py-3">
          <AnimatePresence initial={false}>
            {lines.map((line) => {
              const busy = pending === line.itemId;
              const max = line.available ?? 99;
              const isPreorder = line.fulfillmentMode === "preorder";

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
                  className={`lift overflow-hidden rounded-card border bg-paper shadow-[var(--shadow-raise)] max-sm:shadow-none ${
                    line.problem ? "border-stamp-red" : "border-blue-300 max-sm:border-transparent"
                  } ${busy ? "opacity-70" : ""}`}
                >
                  <SwipeRow disabled={busy} onRemove={() => change(line.itemId, 0)}>
                  {/*
                   * On a phone, a slip in three columns — photograph; name and
                   * terms; option — with the line total and a small stepper
                   * along its foot. The two inner groups dissolve into that
                   * grid with `contents`, so there is one set of controls at
                   * every width. From `sm` it is the three-column row it
                   * always was.
                   */}
                  <div className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 p-3 sm:flex sm:flex-wrap sm:gap-5 sm:p-5">
                    <Link
                      href={`/products/${line.productSlug}`}
                      className="media-zoom surface-studio row-span-4 size-16 shrink-0 overflow-hidden rounded-control sm:size-28 sm:rounded-card sm:border sm:border-blue-300"
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

                    <div className="contents sm:flex sm:min-w-[180px] sm:flex-1 sm:flex-col sm:gap-1.5">
                      <Link
                        href={`/products/${line.productSlug}`}
                        className="link-draw col-start-2 row-start-1 self-start font-display text-[0.875rem] leading-snug text-ink max-sm:line-clamp-2 sm:text-h3"
                      >
                        {line.productTitle}
                      </Link>

                      {/* Only when there is a choice to report: a product with
                          one version should read as its own name (D-043). On a
                          phone it sits opposite the name, as in the reference. */}
                      {line.optionSummary ? (
                        <p className="col-start-3 row-start-1 max-w-[7.5rem] truncate text-right text-[0.75rem] leading-snug text-ink/70 sm:max-w-none sm:overflow-visible sm:whitespace-normal sm:text-left sm:text-meta">
                          {line.optionSummary}
                        </p>
                      ) : null}

                      <div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:mt-0.5">
                        <span className="hidden sm:inline-flex">
                          <StatusBadge tone={isPreorder ? "preorder" : "positive"}>
                            {isPreorder ? "Preorder" : "In stock"}
                          </StatusBadge>
                        </span>
                        <span className="text-[0.75rem] text-ink/70 sm:hidden">
                          {isPreorder ? "Preorder" : "In stock"}
                        </span>

                        {/* The deposit is the single most surprising thing on a
                            preorder line, so it is named on the line itself
                            rather than only in the total. */}
                        {line.paymentMode === "deposit" &&
                        line.depositPercent !== null ? (
                          <span className="text-[0.75rem] text-ink/70 sm:text-meta">
                            {line.depositPercent}% deposit now
                          </span>
                        ) : null}
                      </div>

                      <p className="hidden text-meta tabular-nums text-ink/70 sm:block">
                        {formatBdt(line.unitPriceBdt)} each
                      </p>

                      {line.problem ? (
                        <p className="col-span-2 col-start-2 row-start-3 mt-1 flex items-start gap-2 text-meta text-stamp-red-text">
                          <IconAlert size={16} className="mt-0.5 shrink-0" />
                          {line.problem}
                        </p>
                      ) : null}
                    </div>

                    <div className="contents sm:flex sm:flex-col sm:items-end sm:gap-3">
                      <p className="col-start-2 row-start-4 self-center text-[1rem] font-extrabold tabular-nums text-ink sm:font-display sm:text-price sm:font-semibold">
                        {formatBdt(line.lineTotalBdt)}
                      </p>

                      {/*
                       * A stepper rather than a bare number box. The input is
                       * still there and still typeable — it carries the label
                       * and the value for anyone using a keyboard or a screen
                       * reader — but the two buttons are what a thumb reaches
                       * for, and they commit immediately instead of waiting
                       * for a blur that a phone keyboard makes awkward.
                       *
                       * On a phone it is smaller and borderless, and at a
                       * quantity of one its minus becomes a bin.
                       */}
                      <div className="col-start-3 row-start-4 mt-1 flex items-center justify-self-end rounded-control sm:mt-0 sm:border sm:border-blue-300 sm:bg-paper">
                        <button
                          type="button"
                          onClick={() =>
                            change(line.itemId, Math.max(1, line.quantity - 1))
                          }
                          disabled={busy || line.quantity <= 1}
                          className={`inline-flex size-9 items-center justify-center rounded-control bg-blue-50 text-ink transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent sm:size-10 sm:rounded-l-control sm:rounded-r-none sm:bg-transparent sm:text-blue-600 ${
                            line.quantity <= 1 ? "max-sm:hidden" : ""
                          }`}
                        >
                          <IconMinus size={16} />
                          <span className="sr-only">
                            One fewer {line.productTitle}
                          </span>
                        </button>
                        {line.quantity <= 1 ? (
                          <button
                            type="button"
                            onClick={() => change(line.itemId, 0)}
                            disabled={busy}
                            className="inline-flex size-9 items-center justify-center rounded-control bg-stamp-red/10 text-stamp-red-text transition-colors disabled:opacity-60 sm:hidden"
                          >
                            <IconTrash size={16} />
                            <span className="sr-only">Remove {line.productTitle}</span>
                          </button>
                        ) : null}

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
                          className="h-9 w-9 bg-transparent text-center text-body font-semibold tabular-nums [appearance:textfield] focus:shadow-none sm:h-10 sm:w-12 sm:border-x sm:border-blue-300 sm:font-normal [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />

                        <button
                          type="button"
                          onClick={() => change(line.itemId, line.quantity + 1)}
                          disabled={busy || line.quantity >= max}
                          className="inline-flex size-9 items-center justify-center rounded-control bg-blue-50 text-ink transition-colors hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent sm:size-10 sm:rounded-l-none sm:rounded-r-control sm:bg-transparent sm:text-blue-600"
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
                        className="hidden min-h-9 items-center gap-1.5 rounded-control px-2 text-meta text-ink/70 transition-colors hover:bg-blue-50 hover:text-stamp-red-text disabled:opacity-60 sm:inline-flex"
                      >
                        <IconClose size={14} />
                        Remove
                      </button>

                      {signedIn ? (
                        <button
                          type="button"
                          onClick={() => saveForLater(line.itemId)}
                          disabled={busy}
                          className="col-start-3 row-start-2 inline-flex min-h-8 items-center justify-self-end rounded-control text-[0.75rem] font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-60 sm:min-h-9 sm:gap-1.5 sm:px-2 sm:text-meta"
                        >
                          Save for later
                          <span className="sr-only"> {line.productTitle}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                  </SwipeRow>
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

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
          <LinkButton href="/search?available=1" variant="quiet" size="sm">
            Keep browsing
          </LinkButton>
          <p className="text-[0.75rem] text-ink/70 sm:hidden">
            Swipe a line left to remove it.
          </p>
        </div>
      </div>

      {/*
       * The phone's checkout bar (D-047): what is due and the way to pay, at
       * the foot of the screen for the whole visit, as in the owner's
       * reference. The summary below keeps the breakdown; its own button is
       * a desktop's.
       */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-4 border-t border-blue-300 bg-paper/95 pb-[max(0.625rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-2.5 shadow-[0_-8px_24px_-16px_rgb(18_35_63/0.35)] backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="text-meta text-ink/70">
            {balance > 0 ? "Due now" : "Subtotal"}
          </p>
          <p className="font-display text-[1.375rem] font-bold leading-tight tabular-nums text-ink">
            {formatBdt(dueNowBdt)}
          </p>
        </div>
        {hasProblems ? (
          <button
            type="button"
            disabled
            className="inline-flex min-h-12 cursor-not-allowed items-center justify-center rounded-control border border-blue-300 bg-blue-50 px-5 text-body font-medium text-ink/70"
          >
            Fix flagged items
          </button>
        ) : (
          <LinkButton href="/checkout" variant="primary" className="min-h-12 min-w-36 px-7">
            Checkout
          </LinkButton>
        )}
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

        <div className="mt-5 hidden lg:block">
          {hasProblems ? (
            /* A link cannot be disabled, so the blocked state is a real
               button that says why rather than a dead anchor. */
            <button
              type="button"
              disabled
              className="inline-flex min-h-11 w-full cursor-not-allowed items-center justify-center rounded-control border border-blue-300 bg-blue-50 px-5 text-body font-medium text-ink/70"
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
