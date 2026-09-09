import Link from "next/link";
import { IconStar } from "./icons";
import { CapacityMeter } from "./capacity-meter";
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
 * One fixed shape wherever a product appears. The whole card is a single link,
 * and nothing interactive nests inside it.
 *
 * The redesign brief put the photograph in charge: a large rounded image, then
 * a bold name, a line of the listing's own description, and a heavy price. The
 * card carries the same four facts it always did — what it is, what it costs,
 * whether it can still be had, and when it lands — but it states them in that
 * order and stops there. The badges, meters and ribbons that used to sit on
 * every card now appear only when they are saying something true and urgent
 * about *this* product; a warning printed on every card is one nobody reads on
 * the card where it matters.
 */
export function ProductCard({
  product,
  /** A denser variant for grids inside a page rather than a showcase row. */
  compact = false,
}: {
  product: ProductCardData;
  compact?: boolean;
}) {
  const arrival = formatArrivalWindow(product.arrivesFrom, product.arrivesTo);
  const soldOut =
    product.remainingCapacity !== null && product.remainingCapacity <= 0;

  // The database decides whether the window is closing soon, so every card
  // agrees and nothing is computed against a clock that differs per process.
  const closingSoon = !soldOut && product.closingSoon;

  /*
   * The meter earns its place only when a batch is genuinely going. Otherwise
   * the availability is one line of type, which is what the reference layout
   * asks for and what a catalogue reads like.
   */
  const pressure =
    product.remainingCapacity !== null && product.totalCapacity
      ? 1 - product.remainingCapacity / product.totalCapacity
      : 0;
  const showMeter = !soldOut && pressure >= 0.6;

  const availability = soldOut
    ? "Batch full"
    : closingSoon
      ? "Closing soon"
      : (statusLabels[product.status] ?? product.status);

  return (
    <Link
      href={`/products/${product.slug}`}
      className="media-zoom lift group flex h-full flex-col rounded-card bg-paper p-2 text-ink shadow-[var(--shadow-raise)] ring-1 ring-blue-300/70 transition-shadow hover:shadow-[var(--shadow-lift)]"
    >
      <div className="surface-studio relative aspect-square w-full overflow-hidden rounded-[var(--radius-media)]">
        {product.imageUrl ? (
          /* Seed and uploaded media are served from this origin; next/image
             arrives with the object-storage integration. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.imageAlt}
            width={640}
            height={640}
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <ProductArt
            title={product.title}
            seed={product.slug}
            className="size-full"
          />
        )}

        {/* Only when the window really is close, or really is gone: urgency
            invented is urgency nobody believes the second time. */}
        {soldOut || closingSoon ? (
          <span
            className={`absolute left-3 top-3 rounded-control px-2.5 py-1 text-meta font-bold shadow-[var(--shadow-raise)] backdrop-blur-sm ${
              soldOut
                ? "bg-ink/85 text-paper"
                : "bg-paper/95 text-stamp-red-text"
            }`}
          >
            {soldOut ? "Batch full" : "Closing soon"}
          </span>
        ) : null}
      </div>

      <div
        className={`flex flex-1 flex-col gap-1.5 px-1.5 pb-1 pt-3.5 ${compact ? "" : "sm:px-2.5"}`}
      >
        {product.brand ? (
          <span className="text-meta font-semibold uppercase tracking-[0.12em] text-ink/70 [overflow-wrap:anywhere]">
            {product.brand}
          </span>
        ) : null}

        <h3
          className={`font-display leading-snug text-ink [overflow-wrap:anywhere] ${
            compact ? "text-[1rem] sm:text-h3" : "text-h3 sm:text-[1.3125rem]"
          }`}
        >
          {product.title}
        </h3>

        {product.summary ? (
          <p className="line-clamp-2 text-meta leading-relaxed text-ink/70">
            {product.summary}
          </p>
        ) : null}

        {product.reviewCount > 0 ? (
          <p className="flex items-center gap-1.5 text-meta text-ink/70">
            <IconStar size={14} className="shrink-0 fill-brass text-brass" />
            <span className="font-semibold tabular-nums">
              {product.ratingAverage}
            </span>
            <span aria-hidden="true">·</span>
            {product.reviewCount} review{product.reviewCount === 1 ? "" : "s"}
          </p>
        ) : null}

        {/* Pushes price and availability to the foot, so a row of cards with
            different title lengths still lines up along it. */}
        <div className="mt-auto flex flex-col gap-2 pt-3">
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span
              className={`font-display font-extrabold tabular-nums text-ink ${compact ? "text-price" : "text-[1.5rem] leading-none"}`}
            >
              {product.fromPriceBdt === null
                ? "Price to be confirmed"
                : formatBdt(product.fromPriceBdt)}
            </span>
            <span
              className={`text-meta font-semibold ${
                soldOut
                  ? "text-stamp-red-text"
                  : closingSoon
                    ? "text-brass-text"
                    : "text-ink/70"
              }`}
            >
              {availability}
            </span>
          </p>

          {showMeter ? (
            <CapacityMeter
              remaining={product.remainingCapacity}
              total={product.totalCapacity}
            />
          ) : arrival ? (
            <p className="text-meta text-ink/70">Arrives {arrival}</p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
