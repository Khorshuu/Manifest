import type { Metadata } from "next";
import Link from "next/link";
import { ProductCard } from "@/components/product-card";
import {
  getCategoryTree,
  listClosingSoon,
  listProductCards,
} from "@/lib/catalog";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Preorder American goods, delivered in Bangladesh",
  description:
    "Preorder niche American products at a fixed landed price — shipping and customs duty included — with a stated arrival window.",
};

export const dynamic = "force-dynamic";

/** Thin single-line icons, no background shape, per the design guidelines. */
function CategoryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-8 stroke-ink"
      fill="none"
      strokeWidth="1.25"
      strokeLinecap="square"
    >
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </svg>
  );
}

export default async function HomePage() {
  const [closingSoon, newest, tree] = await Promise.all([
    listClosingSoon(4),
    listProductCards({ sort: "newest", limit: 8 }),
    getCategoryTree(),
  ]);

  const hero = closingSoon[0] ?? newest[0] ?? null;
  const topCategories = tree.slice(0, 6);

  return (
    <>
      {/* Signature pattern: photography-led hero, left-aligned, numbered index */}
      <section className="border-b border-blue-300">
        <div className="mx-auto grid w-full max-w-[1280px] gap-8 px-4 py-12 md:grid-cols-2 md:items-center md:px-6 md:py-16">
          <div className="flex gap-6">
            <span
              aria-hidden="true"
              className="hidden font-display text-meta text-blue-600 md:block"
            >
              01
            </span>

            <div className="flex flex-col gap-5">
              <h1 className="max-w-[18ch] font-display text-display leading-tight text-ink">
                American goods, landed in Bangladesh
              </h1>
              <p className="max-w-[60ch] text-body text-ink/80">
                We buy direct from the United States and ship to your door. The
                price you see includes shipping and customs duty, and every
                listing states when it will arrive.
              </p>

              {hero ? (
                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    href={`/products/${hero.slug}`}
                    className="inline-flex min-h-11 items-center rounded-control bg-brass px-5 text-body font-medium text-ink transition-colors duration-100 hover:bg-brass/90"
                  >
                    Preorder {hero.title}
                  </Link>
                  {hero.closesAt ? (
                    <span className="text-meta text-ink/70">
                      Closes {formatDate(hero.closesAt)}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="aspect-[4/3] w-full overflow-hidden rounded-card border border-blue-300 bg-blue-50">
            {hero?.imageUrl ? (
              /* See ProductCard: placeholder media until storage lands. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={hero.imageUrl}
                alt={hero.imageAlt}
                className="size-full object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex size-full items-center justify-center text-meta text-blue-600"
              >
                Product photography
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Signature pattern: the one blue-50 band on the page */}
      <section className="border-b border-blue-300 bg-blue-50">
        <ul className="mx-auto grid w-full max-w-[1280px] gap-6 px-4 py-8 md:grid-cols-3 md:px-6">
          {[
            {
              title: "Sourced direct from the US",
              body: "Bought from American retailers, not resold through a chain of middlemen.",
            },
            {
              title: "Fixed preorder windows",
              body: "Each listing states when it closes and when it should arrive.",
            },
            {
              title: "One price, duty included",
              body: "Shipping and customs are already in the price. Nothing to pay on delivery.",
            },
          ].map((point) => (
            <li key={point.title} className="flex gap-3">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="mt-1 size-5 shrink-0 stroke-blue-600"
                fill="none"
                strokeWidth="1.25"
                strokeLinecap="square"
              >
                <path d="m4 12 5 5L20 6" />
              </svg>
              <div>
                <p className="text-body font-medium text-ink">{point.title}</p>
                <p className="mt-1 text-meta text-ink/70">{point.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {topCategories.length > 0 ? (
        <section className="mx-auto w-full max-w-[1280px] px-4 py-12 md:px-6">
          <h2 className="font-display text-h2 text-ink">Browse</h2>
          <ul className="mt-6 flex flex-wrap gap-x-10 gap-y-8">
            {topCategories.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="flex w-24 flex-col items-center gap-2 text-center"
                >
                  <CategoryIcon />
                  <span className="text-meta text-ink">{category.name}</span>
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
            {newest.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
