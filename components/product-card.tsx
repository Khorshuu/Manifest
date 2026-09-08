import Link from "next/link";
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

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-3 transition-colors duration-100 hover:border-blue-500"
    >
      <div className="aspect-square w-full overflow-hidden rounded-card bg-blue-50">
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
          <div
            aria-hidden="true"
            className="flex size-full items-center justify-center text-meta text-blue-600"
          >
            No photo yet
          </div>
        )}
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
