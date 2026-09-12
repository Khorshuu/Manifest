import Link from "next/link";
import { IconStar } from "./icons";
import { CapacityMeter } from "./capacity-meter";
import { MediaImage } from "./media-image";
import { ProductArt } from "./product-art";
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
 * One fixed shape wherever a product appears — a listing, a search, a
 * recommendation row, the recently viewed strip. The whole card is a single
 * link, and nothing interactive nests inside it.
 *
 * A normal commerce card, sized so more of the catalogue is on screen at once:
 * the photograph leads, then a two-line name, one line of description, and the
 * price. The type is deliberately small — the words used to take as much room
 * as the picture. Badges and meters appear only when they say something true
 * and urgent about this product.
 */
export function ProductCard({
  product,
}: {
  product: ProductCardData;
  /** Kept for callers written before every card became compact. */
  compact?: boolean;
}) {
  const arrival = formatArrivalWindow(product.arrivesFrom, product.arrivesTo);
  const soldOut =
    product.remainingCapacity !== null && product.remainingCapacity <= 0;

  // The database decides whether the window is closing soon, so every card
  // agrees and nothing is computed against a clock that differs per process.
  const closingSoon = !soldOut && product.closingSoon;

  const pressure =
    product.remainingCapacity !== null && product.totalCapacity
      ? 1 - product.remainingCapacity / product.totalCapacity
      : 0;
  const showMeter = !soldOut && pressure >= 0.6;

  const availability = soldOut
    ? "Batch full"
    : product.outOfStock
      ? "Out of stock"
      : closingSoon
        ? "Closing soon"
        : (statusLabels[product.status] ?? product.status);

  return (
    <Link
      href={`/products/${product.slug}`}
      className="media-zoom lift group flex h-full flex-col rounded-card bg-paper p-1.5 text-ink shadow-[var(--shadow-raise)] ring-1 ring-blue-300/60 transition-shadow hover:shadow-[var(--shadow-lift)]"
    >
      <div className="surface-studio relative aspect-square w-full overflow-hidden rounded-[calc(var(--radius-media)-8px)]">
        {product.imageUrl ? (
          <MediaImage
            src={product.imageUrl}
            alt={product.imageAlt}
            /* Two across on a phone, three on a tablet, four on a laptop and
               five on a wide screen — see `.product-grid` in globals.css. */
            sizes="(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
            className="object-cover"
          />
        ) : (
          <ProductArt
            title={product.title}
            seed={product.slug}
            className="size-full"
          />
        )}

        {soldOut || closingSoon ? (
          <span
            className={`absolute left-2 top-2 rounded-[6px] px-1.5 py-0.5 text-[0.6875rem] font-bold shadow-[var(--shadow-raise)] backdrop-blur-sm ${
              soldOut
                ? "bg-ink/85 text-paper"
                : "bg-paper/95 text-stamp-red-text"
            }`}
          >
            {soldOut ? "Batch full" : "Closing soon"}
          </span>
        ) : null}

        {/* A saving only when a sale is actually running. */}
        {product.discountPercent ? (
          <span className="absolute right-2 top-2 rounded-[6px] bg-stamp-red-text px-1.5 py-0.5 text-[0.6875rem] font-bold tabular-nums text-paper shadow-[var(--shadow-raise)]">
            −{product.discountPercent}%<span className="sr-only"> off</span>
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-1 pb-1 pt-2">
        {product.brand ? (
          <span className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ink/70">
            {product.brand}
          </span>
        ) : null}

        <h3 className="line-clamp-2 text-[0.875rem] font-semibold leading-[1.3] text-ink [overflow-wrap:anywhere] sm:text-[0.9375rem]">
          {product.title}
        </h3>

        {product.summary ? (
          <p className="line-clamp-1 text-[0.75rem] leading-snug text-ink/70">
            {product.summary}
          </p>
        ) : null}

        {product.reviewCount > 0 ? (
          <p className="mt-0.5 flex items-center gap-1 text-[0.75rem] text-ink/70">
            <IconStar size={12} className="shrink-0 fill-brass text-brass" />
            <span className="font-semibold tabular-nums">
              {product.ratingAverage}
            </span>
            <span className="tabular-nums">({product.reviewCount})</span>
            <span className="sr-only">
              {product.reviewCount === 1 ? "review" : "reviews"}
            </span>
          </p>
        ) : null}

        {/* Pushes price and availability to the foot, so a row of cards with
            different title lengths still lines up along it. */}
        <div className="mt-auto flex flex-col gap-1 pt-1.5">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-[1rem] font-extrabold tabular-nums leading-tight text-ink sm:text-[1.0625rem]">
              {product.fromPriceBdt === null
                ? "Price to be confirmed"
                : formatBdt(product.fromPriceBdt)}
            </span>
            {product.listPriceBdt !== null && product.fromPriceBdt !== null ? (
              <span className="text-[0.75rem] tabular-nums text-ink/70 line-through">
                <span className="sr-only">Regular price </span>
                {formatBdt(product.listPriceBdt)}
              </span>
            ) : null}
          </p>

          <p className="flex flex-wrap items-center justify-between gap-x-2 text-[0.6875rem] leading-snug">
            <span
              className={`font-semibold ${
                soldOut || product.outOfStock
                  ? "text-stamp-red-text"
                  : closingSoon
                    ? "text-brass-text"
                    : "text-ink/70"
              }`}
            >
              {availability}
            </span>
            {!showMeter && arrival ? (
              <span className="text-ink/70">Arrives {arrival}</span>
            ) : null}
          </p>

          {showMeter ? (
            <CapacityMeter
              remaining={product.remainingCapacity}
              total={product.totalCapacity}
            />
          ) : null}
        </div>
      </div>
    </Link>
  );
}
