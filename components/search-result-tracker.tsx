"use client";

import type { ReactNode } from "react";

/**
 * Notes which search result a shopper chose, for the click-through figure on
 * the search admin page.
 *
 * One listener on the grid rather than one per card, and the note goes as a
 * beacon — it is sent even though the page is navigating away, and it never
 * holds the navigation up. It carries the search, the product and its place in
 * the results; nothing about who clicked.
 */
export function SearchResultTracker({
  query,
  products,
  children,
}: {
  query: string;
  /** Product slug to its id and 1-based position in the results. */
  products: Record<string, { id: string; position: number }>;
  children: ReactNode;
}) {
  return (
    <div
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          'a[href^="/products/"]',
        );
        if (!anchor) return;

        const slug = anchor
          .getAttribute("href")
          ?.slice("/products/".length)
          .split(/[?#]/)[0];
        const product = slug ? products[slug] : undefined;
        if (!product) return;

        const body = JSON.stringify({
          q: query,
          productId: product.id,
          position: product.position,
        });

        try {
          const sent = navigator.sendBeacon?.(
            "/api/search/click",
            new Blob([body], { type: "application/json" }),
          );
          if (!sent) {
            void fetch("/api/search/click", {
              method: "POST",
              body,
              keepalive: true,
              headers: { "content-type": "application/json" },
            }).catch(() => undefined);
          }
        } catch {
          // Analytics never gets in the way of the click itself.
        }
      }}
    >
      {children}
    </div>
  );
}
