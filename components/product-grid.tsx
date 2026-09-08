import { ProductCard } from "./product-card";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

/**
 * Every listing renders through this, so the empty state is defined once and
 * always explains what to do next rather than showing a bare blank area.
 */
export function ProductGrid({
  products,
  emptyTitle,
  emptyBody,
}: {
  products: ProductCardData[];
  emptyTitle: string;
  emptyBody: string;
}) {
  if (products.length === 0) {
    return (
      <div className="border border-blue-300 p-8">
        <p className="text-body text-ink">{emptyTitle}</p>
        <p className="mt-2 max-w-[60ch] text-meta text-ink/70">{emptyBody}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
