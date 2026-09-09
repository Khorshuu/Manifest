import Link from "next/link";
import { Stagger, StaggerItem } from "./motion";
import { ProductCard } from "./product-card";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

/**
 * A named row of products with a reason for existing.
 *
 * Every such row on the site goes through this: "More like this" under a
 * product, the category row beneath it, and anything added later. They were
 * hand-written blocks that had already drifted apart in heading size, column
 * rules and spacing.
 *
 * The column count follows the number of cards. A three-card row in a
 * four-column grid leaves a gap the width of a card, which reads as a listing
 * that failed to load rather than a short one.
 */
export function RecommendationSection({
  eyebrow,
  title,
  products,
  link,
}: {
  eyebrow: string;
  title: string;
  products: ProductCardData[];
  link?: { href: string; label: string };
}) {
  if (products.length === 0) return null;

  return (
    <section className="mt-16 border-t border-ink/15 pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-3 text-meta font-semibold uppercase tracking-[0.18em] text-brass-text">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            {eyebrow}
          </p>
          <h2 className="mt-2 font-display text-h1 text-ink">{title}</h2>
        </div>

        {link ? (
          <Link
            href={link.href}
            className="link-draw text-meta font-semibold text-blue-600"
          >
            {link.label}
          </Link>
        ) : null}
      </div>

      <Stagger
        className={`mt-8 grid grid-cols-2 gap-3 sm:gap-5 ${
          products.length >= 4
            ? "lg:grid-cols-4"
            : products.length === 3
              ? "lg:grid-cols-3"
              : "lg:grid-cols-2"
        }`}
      >
        {products.map((product) => (
          <StaggerItem key={product.id} className="h-full">
            <ProductCard product={product} compact />
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
