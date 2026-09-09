import Link from "next/link";
import { ProductCard } from "./product-card";
import type { ProductCard as ProductCardData } from "@/lib/catalog";

/**
 * The curated row directly beneath the hero.
 *
 * It overlaps the foot of the photograph so the two read as one composition
 * rather than as a banner with a shelf under it, which is the whole point of
 * putting it here: one ordinary scroll from the top of the page and a shopper
 * has a name, a price and a way in.
 *
 * Four across on a wide screen with room for a fifth and sixth reached by
 * scrolling the row — the overflow is what proves this is a selection rather
 * than a fixed set of slots. On a phone it is a swipeable rail of large cards,
 * never a grid of small ones.
 */
export function FeaturedShowcase({
  products,
  title = "This batch",
  summary,
}: {
  products: ProductCardData[];
  title?: string;
  summary?: string;
}) {
  if (products.length === 0) return null;

  return (
    <section
      aria-label="Featured products"
      className="relative z-20 -mt-[clamp(3rem,7vw,6rem)]"
    >
      <div className="mx-auto w-full max-w-[1360px] px-4 md:px-8">
        {/*
         * A rail at every width, rather than a grid above `lg`.
         *
         * Four cards fill a wide screen exactly, and the fifth and sixth are
         * reached by scrolling the row — which is how a curated selection
         * behaves. A four-column grid would either hide them or leave a second
         * row with two cards and two holes in it.
         */}
        <ul className="rail flex gap-3 overflow-x-auto pb-6 md:gap-5">
          {products.map((product, position) => (
            <li
              key={product.id}
              /*
               * The entrance is on the row item rather than the card: the card
               * carries a hover transform of its own, and an animation with a
               * `both` fill would pin that transform at its end state.
               */
              className="animate-rise w-[76%] shrink-0 sm:w-[46%] lg:w-[calc((100%-3.75rem)/4)]"
              style={{ animationDelay: `${position * 70}ms` }}
            >
              <ProductCard product={product} />
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-ink/10 pb-2 pt-3">
          <div>
            <h2 className="font-display text-h3 text-ink">{title}</h2>
            {summary ? (
              <p className="mt-1 max-w-[52ch] text-meta text-ink/70">
                {summary}
              </p>
            ) : null}
          </div>
          <Link
            href="/search?preorder=1"
            className="link-draw text-meta font-semibold text-blue-600"
          >
            Every open window
          </Link>
        </div>
      </div>
    </section>
  );
}
