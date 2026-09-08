import type { Metadata } from "next";
import Link from "next/link";
import { HeroCarousel } from "@/components/hero-carousel";
import { ProductArt } from "@/components/product-art";
import { ProductCard } from "@/components/product-card";
import {
  getCategoryTree,
  listClosingSoon,
  listProductCards,
} from "@/lib/catalog";
import { formatBdt } from "@/lib/money";

export const metadata: Metadata = {
  title: "Preorder American goods, delivered in Bangladesh",
  description:
    "Preorder niche American products at a fixed landed price — shipping and customs duty included — with a stated arrival window.",
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [closingSoon, newest, tree] = await Promise.all([
    listClosingSoon(4),
    listProductCards({ sort: "newest", limit: 8 }),
    getCategoryTree(),
  ]);

  // The featured rotation: whatever is closing soonest, then the newest, up
  // to four. Real products only — an empty slot would be an advertisement for
  // nothing.
  const featured = [...closingSoon, ...newest]
    .filter(
      (product, index, all) =>
        all.findIndex((other) => other.slug === product.slug) === index,
    )
    .slice(0, 4);

  // What is already shown above does not appear again below.
  const shownSlugs = new Set([
    ...featured.map((product) => product.slug),
    ...closingSoon.map((product) => product.slug),
  ]);
  const arrivals = newest.filter((product) => !shownSlugs.has(product.slug));

  const slides = featured.map((product) => ({
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    priceLabel:
      product.fromPriceBdt === null
        ? "Price to be confirmed"
        : formatBdt(product.fromPriceBdt),
    closesAt: product.closesAt ? product.closesAt.toISOString() : null,
    remaining: product.remainingCapacity,
  }));
  const topCategories = tree.slice(0, 6);

  return (
    <>
      <HeroCarousel slides={slides} />

      <section className="border-b border-ink/15 bg-paper-raised">
        <div className="mx-auto w-full max-w-[1280px] px-4 py-12 md:px-6">
          <div className="max-w-[52ch]">
            <h2 className="font-display text-h2 text-ink">
              Buying before it exists here
            </h2>
            <p className="mt-2 text-body text-ink/75">
              These goods are not in Bangladesh yet. You order while the window
              is open, we buy the whole batch in the United States, and it comes
              in together.
            </p>
          </div>

          <ol className="mt-8 grid gap-px bg-ink/15 md:grid-cols-3">
            {[
              {
                title: "Order while the window is open",
                body: "Each listing shows exactly how long is left and how many places remain in the batch.",
              },
              {
                title: "We buy and fly it in",
                body: "When the window shuts we place the order in the US. Nothing is bought before that.",
              },
              {
                title: "It clears customs and arrives",
                body: "Duty is already inside the price you paid, so there is nothing to settle at the door.",
              },
            ].map((step, index) => (
              <li key={step.title} className="bg-paper-raised p-6">
                <div className="flex items-baseline gap-3">
                  <span
                    aria-hidden="true"
                    className="font-display text-h2 tabular-nums text-brass-text"
                  >
                    {index + 1}
                  </span>
                  <h3 className="font-display text-h3 text-ink">{step.title}</h3>
                </div>
                <p className="mt-2 max-w-[38ch] text-meta text-ink/70">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {topCategories.length > 0 ? (
        <section className="mx-auto w-full max-w-[1280px] px-4 py-12 md:px-6">
          <h2 className="font-display text-h2 text-ink">Browse</h2>
          <ul className="mt-6 grid gap-px bg-ink/15 sm:grid-cols-2 lg:grid-cols-3">
            {topCategories.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="media-zoom group flex items-center gap-5 bg-paper p-5 transition-colors hover:bg-paper-raised"
                >
                  <span className="size-20 shrink-0 overflow-hidden">
                    <ProductArt
                      title={category.name}
                      seed={category.slug}
                      className="size-full"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-h3 text-ink">
                      {category.name}
                    </span>
                    <span className="mt-1 block text-meta text-ink/70">
                      {category.children.length > 0
                        ? category.children.map((child) => child.name).join(", ")
                        : "Open preorders"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closingSoon.length > 0 ? (
        <section className="mx-auto w-full max-w-[1280px] px-4 pb-12 md:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-h2 text-ink">Closing soon</h2>
            <Link
              href="/search?preorder=1"
              className="text-meta text-blue-600 hover:underline"
            >
              All open preorders
            </Link>
          </div>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {closingSoon.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mx-auto w-full max-w-[1280px] px-4 pb-16 md:px-6">
        <h2 className="font-display text-h2 text-ink">New arrivals</h2>
        {newest.length === 0 ? (
          <p className="mt-4 text-body text-ink/70">
            Nothing listed yet. Check back shortly.
          </p>
        ) : (
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {arrivals.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
