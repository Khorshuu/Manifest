"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { ProductArt } from "@/components/product-art";
import { useState } from "react";
import { Button } from "@/components/button";
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
};

export function CartLines({
  lines,
  subtotalBdt,
  dueNowBdt,
  hasProblems,
}: {
  lines: CartLineView[];
  subtotalBdt: number;
  dueNowBdt: number;
  hasProblems: boolean;
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

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        <ul className="border-t border-blue-300">
          <AnimatePresence initial={false}>
          {lines.map((line) => (
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
              className="flex flex-wrap gap-4 overflow-hidden border-b border-blue-300 py-5"
            >
              <Link
                href={`/products/${line.productSlug}`}
                className="media-zoom surface-studio size-24 shrink-0 overflow-hidden rounded-card border border-blue-300"
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

              <div className="flex min-w-[200px] flex-1 flex-col gap-1">
                <Link
                  href={`/products/${line.productSlug}`}
                  className="font-display text-h3 text-ink hover:underline"
                >
                  {line.productTitle}
                </Link>
                <p className="text-meta text-ink/70">{line.optionSummary}</p>
                <p className="text-meta text-ink/70 tabular-nums">
                  {formatBdt(line.unitPriceBdt)} each
                </p>

                {line.problem ? (
                  <p className="mt-1 text-meta text-stamp-red-text">{line.problem}</p>
                ) : null}
              </div>

              <div className="flex flex-col items-end gap-2">
                <p className="text-price font-semibold tabular-nums text-ink">
                  {formatBdt(line.lineTotalBdt)}
                </p>

                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`quantity-${line.itemId}`}
                    className="sr-only"
                  >
                    Quantity of {line.productTitle}
                  </label>
                  <input
                    id={`quantity-${line.itemId}`}
                    type="number"
                    min={1}
                    max={99}
                    defaultValue={line.quantity}
                    disabled={pending === line.itemId}
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      if (next !== line.quantity) change(line.itemId, next);
                    }}
                    className="min-h-11 w-20 rounded-control border border-blue-300 px-3 text-body tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => change(line.itemId, 0)}
                    disabled={pending === line.itemId}
                    className="min-h-11 px-2 text-meta text-blue-600 hover:underline disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </motion.li>
          ))}
          </AnimatePresence>
        </ul>

        <div aria-live="polite">
          {error ? (
            <p className="mt-4 text-meta text-stamp-red-text">{error}</p>
          ) : null}
        </div>
      </div>

      <aside className="h-fit rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] lg:sticky lg:top-24">
        <h2 className="font-display text-h2 text-ink">Summary</h2>

        <dl className="mt-4 flex flex-col gap-2 text-body">
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Subtotal</dt>
            <dd className="tabular-nums text-ink">{formatBdt(subtotalBdt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Shipping and duty</dt>
            <dd className="text-ink">Included</dd>
          </div>
          {dueNowBdt !== subtotalBdt ? (
            <div className="flex justify-between gap-4 border-t border-blue-300 pt-2">
              <dt className="text-ink/70">Due now</dt>
              <dd className="tabular-nums text-ink">{formatBdt(dueNowBdt)}</dd>
            </div>
          ) : null}
        </dl>

        {/* A blocked checkout says why, on the button's own terms. */}
        {hasProblems ? (
          <p className="mt-4 text-meta text-stamp-red-text">
            Fix the flagged items above before checking out.
          </p>
        ) : null}

        <div className="mt-5">
          {hasProblems ? (
            <Button type="button" disabled>
              Checkout
            </Button>
          ) : (
            <Link
              href="/checkout"
              className="inline-flex min-h-11 items-center justify-center rounded-control bg-brass px-5 text-body font-medium text-ink"
            >
              Checkout
            </Link>
          )}
        </div>
      </aside>
    </div>
  );
}
