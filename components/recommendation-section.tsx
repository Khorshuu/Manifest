import Link from "next/link";
import { Stagger, StaggerItem } from "./motion";
import { ProductCard } from "./product-card";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

/**
 * A named row of products with a reason for existing: "More like this", the
 * category row, recently viewed. Every such row goes through this so their
 * headings, spacing and cards cannot drift apart.
 *
 * It uses the same compact card and the same dense grid as a listing, with a
 * small heading, so a row of recommendations reads as a shelf rather than as
 * a second page of giant tiles.
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
    <section className="mt-8 border-t border-ink/10 pt-5 sm:mt-10 sm:pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brass-text">
            {eyebrow}
          </p>
          <h2 className="mt-0.5 text-[1.125rem] font-bold leading-tight tracking-[-0.01em] text-ink">
            {title}
          </h2>
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

      {/* A sideways shelf on a phone, the grid from `sm` (globals.css). */}
      <Stagger className="product-grid product-rail mt-3 sm:mt-4">
        {products.map((product) => (
          <StaggerItem key={product.id} className="h-full">
            <ProductCard product={product} />
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
