import Link from "next/link";
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
      className="media-zoom group flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-3 transition-colors duration-150 hover:border-ink"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-card bg-blue-50">
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
          <span className="animate-fade-in absolute left-2 top-2 rounded-card border border-stamp-red bg-paper px-2 py-1 text-meta text-stamp-red-text">
            Closing soon
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {product.brand ? (
          <span className="text-meta text-ink/70">{product.brand}</span>
        ) : null}

        <h3 className="font-display text-h3 leading-snug text-ink">
          {product.title}
        </h3>

        {product.reviewCount > 0 ? (
          <p className="text-meta text-ink/70">
            <span aria-hidden="true">★</span> {product.ratingAverage} ·{" "}
            {product.reviewCount} review{product.reviewCount === 1 ? "" : "s"}
          </p>
        ) : null}

        <p className="text-price font-semibold tabular-nums text-ink">
          {product.fromPriceBdt === null
            ? "Price to be confirmed"
            : formatBdt(product.fromPriceBdt)}
        </p>

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
            {soldOut ? "Full" : (statusLabels[product.status] ?? product.status)}
          </StatusBadge>

          {arrival ? (
            <span className="text-meta text-ink/70">Arrives {arrival}</span>
          ) : null}
        </div>

        {/* Scarcity is shown only when the number is real. */}
        {!soldOut &&
        product.remainingCapacity !== null &&
        product.remainingCapacity <= 5 ? (
          <p className="text-meta text-stamp-red-text">
            {product.remainingCapacity} slot
            {product.remainingCapacity === 1 ? "" : "s"} left
          </p>
        ) : null}
      </div>
    </Link>
  );
}
