import Link from "next/link";
import { IconStar } from "./icons";
import { CapacityMeter } from "./capacity-meter";
import { ProductArt } from "./product-art";
import { StatusBadge } from "./status-badge";
import { formatBdt } from "@/lib/money";
import { formatArrivalWindow } from "@/lib/format";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

const statusLabels: Record<string, string> = {
  in_stock: "In stock",
  preorder_open: "Preorder open",
  preorder_closed: "Preorder closed",
  coming_soon: "Coming soon",
  discontinued: "Discontinued",
};

/**
 * One fixed shape wherever a product appears. The whole card is a single
 * link, and nothing interactive nests inside it.
 *
 * The card carries four facts in a fixed order — what it is, what it costs,
 * whether it can still be had, and when it lands. They never move between
 * cards, so a grid can be scanned down a column rather than read card by card.
 */
export function ProductCard({ product }: { product: ProductCardData }) {
  const arrival = formatArrivalWindow(product.arrivesFrom, product.arrivesTo);
  const soldOut =
    product.remainingCapacity !== null && product.remainingCapacity <= 0;

  // The database decides whether the window is closing soon, so every card
  // agrees and nothing is computed against a clock that differs per process.
  const closingSoon = !soldOut && product.closingSoon;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="media-zoom lift group flex h-full flex-col gap-2.5 rounded-card border border-blue-300 bg-paper p-2.5 shadow-[var(--shadow-raise)] sm:gap-3 sm:p-3"
    >
      <div className="surface-studio relative aspect-square w-full overflow-hidden rounded-card">
        {product.imageUrl ? (
          /* Seed images are local placeholders; real media moves to
             next/image once the storage integration lands. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.imageAlt}
            width={400}
            height={400}
            className="size-full object-cover"
          />
        ) : (
          <ProductArt
            title={product.title}
            seed={product.slug}
            className="size-full"
          />
        )}

        {/* Only when the window really is close: urgency invented is urgency
            nobody believes the second time. */}
        {closingSoon ? (
          <span className="animate-rise absolute left-2 top-2 rounded-card border border-stamp-red bg-paper/95 px-2 py-1 text-meta font-medium text-stamp-red-text shadow-[var(--shadow-raise)] backdrop-blur-sm">
            Closing soon
          </span>
        ) : null}

        {/*
         * The arrival window, held against the foot of the photograph until
         * the pointer or the keyboard arrives. It is duplicated in the body
         * below on small screens, so nothing here is only reachable by hover.
         */}
        {arrival ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 hidden translate-y-full bg-ink/85 px-3 py-2 text-meta text-paper backdrop-blur-sm transition-transform duration-300 ease-[var(--ease-out-quint)] group-hover:translate-y-0 group-focus-visible:translate-y-0 sm:block"
          >
            Arrives {arrival}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {product.brand ? (
          <span className="text-meta uppercase tracking-[0.12em] text-ink/70 [overflow-wrap:anywhere]">
            {product.brand}
          </span>
        ) : null}

        <h3 className="font-display text-[1rem] leading-snug text-ink [overflow-wrap:anywhere] sm:text-h3">
          {product.title}
        </h3>

        {product.reviewCount > 0 ? (
          <p className="flex items-center gap-1.5 text-meta text-ink/70">
            <IconStar size={14} className="shrink-0 fill-brass text-brass" />
            <span className="tabular-nums">{product.ratingAverage}</span>
            <span aria-hidden="true">·</span>
            {product.reviewCount} review{product.reviewCount === 1 ? "" : "s"}
          </p>
        ) : null}

        <p className="font-display text-[1.0625rem] font-semibold tabular-nums text-ink sm:text-price">
          {product.fromPriceBdt === null
            ? "Price to be confirmed"
            : formatBdt(product.fromPriceBdt)}
        </p>

        {/* Pushes the availability block to the foot of the card, so a row of
            cards with different title lengths still lines up along it. */}
        <div className="mt-auto flex flex-col gap-2.5 border-t border-blue-200 pt-3">
          <CapacityMeter
            remaining={product.remainingCapacity}
            total={product.totalCapacity}
          />

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={
                soldOut
                  ? "negative"
                  : product.status === "preorder_open"
                    ? "preorder"
                    : product.status === "in_stock"
                      ? "positive"
                      : "neutral"
              }
            >
              {soldOut
                ? "Full"
                : (statusLabels[product.status] ?? product.status)}
            </StatusBadge>

            {arrival ? (
              <span className="text-meta text-ink/70 sm:sr-only">
                Arrives {arrival}
              </span>
            ) : null}
          </div>

          {/* Scarcity is shown only when the number is real, and only when it
              is genuinely scarce — a warning printed on every card is one
              nobody reads on the card where it matters. */}
          {!soldOut &&
          product.remainingCapacity !== null &&
          product.remainingCapacity <= 5 ? (
            <p className="text-meta font-medium text-stamp-red-text">
              Only {product.remainingCapacity} place
              {product.remainingCapacity === 1 ? "" : "s"} left
            </p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
