"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { IconAlert, IconClose } from "@/components/icons";
import { ProductArt } from "@/components/product-art";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";

export type WishlistRow = {
  variantId: string;
  productTitle: string;
  productSlug: string;
  optionSummary: string;
  imageUrl: string | null;
  imageAlt: string;
  priceBdt: number;
  fulfillmentMode: string;
  problem: string | null;
  savedAt: string;
};

export function WishlistList({ entries }: { entries: WishlistRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(variantId: string, action: "cart" | "remove") {
    setPending(variantId);
    setError(null);
    const response = await fetch(
      action === "cart" ? "/api/account/wishlist/move-to-cart" : "/api/account/wishlist",
      {
        method: action === "cart" ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId }),
      },
    );
    const body = await response.json().catch(() => ({}));
    setPending(null);
    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    router.refresh();
  }

  return (
    <>
      <ul className="flex flex-col gap-4">
        {entries.map((entry) => {
          const busy = pending === entry.variantId;
          return (
            <li
              key={entry.variantId}
              className={`lift flex flex-wrap items-start gap-4 rounded-card border bg-paper p-4 shadow-[var(--shadow-raise)] sm:gap-5 sm:p-5 ${
                entry.problem ? "border-stamp-red" : "border-blue-300"
              } ${busy ? "opacity-70" : ""}`}
            >
              <Link
                href={`/products/${entry.productSlug}`}
                tabIndex={-1}
                aria-hidden="true"
                className="media-zoom surface-studio size-24 shrink-0 overflow-hidden rounded-card border border-blue-300"
              >
                {entry.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.imageUrl} alt="" className="size-full object-cover" />
                ) : (
                  <ProductArt title={entry.productTitle} seed={entry.productSlug} className="size-full" />
                )}
              </Link>

              <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
                <Link
                  href={`/products/${entry.productSlug}`}
                  className="link-draw self-start font-display text-h3 leading-snug text-ink"
                >
                  {entry.productTitle}
                </Link>
                <p className="text-meta text-ink/70">{entry.optionSummary}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={entry.fulfillmentMode === "preorder" ? "preorder" : "positive"}>
                    {entry.fulfillmentMode === "preorder" ? "Preorder" : "In stock"}
                  </StatusBadge>
                </div>
                {entry.problem ? (
                  <p className="mt-1 flex items-start gap-2 text-meta text-stamp-red-text">
                    <IconAlert size={16} className="mt-0.5 shrink-0" />
                    {entry.problem}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col items-end gap-3">
                <p className="font-display text-price font-semibold tabular-nums text-ink">
                  {formatBdt(entry.priceBdt)}
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || Boolean(entry.problem)}
                  onClick={() => act(entry.variantId, "cart")}
                >
                  Move to cart
                </Button>
                <button
                  type="button"
                  onClick={() => act(entry.variantId, "remove")}
                  disabled={busy}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-control px-2 text-meta text-ink/70 transition-colors hover:bg-blue-50 hover:text-stamp-red-text disabled:opacity-60"
                >
                  <IconClose size={14} />
                  Remove
                  <span className="sr-only"> {entry.productTitle}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">
        {error ? (
          <p className="mt-4 flex items-center gap-2 text-meta text-stamp-red-text">
            <IconAlert size={16} />
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}
