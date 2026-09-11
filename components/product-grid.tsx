import { EmptyState } from "./empty-state";
import { Stagger, StaggerItem } from "./motion";
import { ProductCard } from "./product-card";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

/**
 * Every listing renders through this, so the empty state is defined once and
 * always explains what to do next rather than showing a bare blank area.
 *
 * The cards arrive in sequence rather than all at once. It costs nothing —
 * the group hides only what is genuinely below the fold and plays each card
 * once — and it is the difference between a grid that appears and a grid that
 * lands.
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
      <EmptyState
        title={emptyTitle}
        body={emptyBody}
        action={{ href: "/search?available=1", label: "See what is open" }}
        secondary={{ href: "/", label: "Back to the shop" }}
      />
    );
  }

  /*
   * Two columns from the smallest screen up, four beside the filter column on
   * a laptop — the shared dense grid in globals.css, so a listing, a search
   * and a recommendation row all show the same number of cards per row.
   */
  return (
    <Stagger className="product-grid product-grid--filtered">
      {products.map((product) => (
        <StaggerItem key={product.id} className="h-full">
          <ProductCard product={product} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}
