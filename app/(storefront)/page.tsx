import type { Metadata } from "next";
import Link from "next/link";
import { CategoryBento } from "@/components/category-bento";
import { ClosingRail } from "@/components/closing-rail";
import { HeroCarousel } from "@/components/hero-carousel";
import { IconCalendar, IconSeal, IconTag } from "@/components/icons";
import { Reveal, Stagger, StaggerItem } from "@/components/motion";
import { ProductCard } from "@/components/product-card";
import { Ticker } from "@/components/ticker";
import {
  collectSubtreeIds,
  countPublicProductsByCategory,
  getCategoryTree,
  pickCategoryImages,
  listClosingSoon,
  listProductCards,
} from "@/lib/catalog";
import { serverInstant } from "@/lib/clock";
import { formatBdt } from "@/lib/money";

export const metadata: Metadata = {
  title: "Preorder American goods, delivered in Bangladesh",
  description:
    "Preorder niche American products at a fixed landed price — shipping and customs duty included — with a stated arrival window.",
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [closingSoon, newest, tree, categoryCounts, serverNow, categoryImages] =
    await Promise.all([
      listClosingSoon(8),
      listProductCards({ sort: "newest", limit: 20 }),
      getCategoryTree(),
      countPublicProductsByCategory(),
      serverInstant(),
      pickCategoryImages(),
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
  // Two full rows at the widest breakpoint. A trailing row with one card in it
  // makes a stocked catalogue look like it ran out.
  const arrivals = newest
    .filter((product) => !shownSlugs.has(product.slug))
    .slice(0, 8);

  /*
   * `serverNow` above is handed to every countdown on the page. Each of them
   * would otherwise read its own clock on the client and disagree with the
   * number already in the HTML, which React reports as a hydration error and
   * repairs by throwing the server markup away.
   */
  const priceLabel = (value: number | null) =>
    value === null ? "Price to be confirmed" : formatBdt(value);

  const slides = featured.map((product) => ({
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    priceLabel: priceLabel(product.fromPriceBdt),
    closesAt: product.closesAt ? product.closesAt.toISOString() : null,
    remaining: product.remainingCapacity,
    total: product.totalCapacity,
  }));

  const railItems = closingSoon.map((product) => ({
    id: product.id,
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    priceLabel: priceLabel(product.fromPriceBdt),
    closesAt: product.closesAt ? product.closesAt.toISOString() : null,
    remaining: product.remainingCapacity,
    total: product.totalCapacity,
  }));

  /*
   * A top-level shelf holds nothing directly — the products are filed in its
   * children — so both the count and the photograph are rolled up from the
   * whole subtree rather than read off the parent row.
   */
  const bentoCategories = tree.slice(0, 5).map((category) => {
    const subtree = collectSubtreeIds(category);
    const image = subtree.map((id) => categoryImages.get(id)).find(Boolean);

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      children: category.children.map((child) => ({
        id: child.id,
        name: child.name,
      })),
      productCount: subtree.reduce(
        (total, id) => total + (categoryCounts.get(id) ?? 0),
        0,
      ),
      imageUrl: image?.url ?? null,
      imageAlt: image?.altText ?? "",
    };
  });

  /*
   * The strip under the hero. Every line is a fact about this shop: the lane
   * the goods travel, what the price already covers, and the batches that are
   * genuinely open right now. Nothing on it is a slogan.
   */
  const openTitles = closingSoon.slice(0, 5).map((product) => product.title);
  const tickerItems = [
    "New York → Dhaka",
    "Duty and freight inside the price",
    "Nothing to settle at the door",
    ...(openTitles.length > 0 ? ["Open now"] : []),
    ...openTitles,
  ];

  return (
    <>
      <HeroCarousel slides={slides} serverNow={serverNow} />
      <Ticker items={tickerItems} />

      <ClosingRail items={railItems} serverNow={serverNow} />

      {/*
       * The dark "how a batch works" band used to sit here and has been taken
       * out at the owner's request. `components/process-band.tsx` is still in
       * the tree, so putting it back is one line.
       *
       * What it explained is not lost: the three assurance cards at the foot of
       * this page make the same three points, the product page walks the whole
       * route stage by stage in `components/journey.tsx`, and the footer states
       * the preorder terms on every page of the site.
       */}
      <div className="surface-paper border-b border-ink/10 py-14">
        <CategoryBento categories={bentoCategories} />
      </div>

      <section className="mx-auto w-full max-w-[1280px] px-4 py-14 md:px-6">
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
                <span aria-hidden="true" className="h-px w-8 bg-brass" />
                Just listed
              </p>
              <h2 className="mt-2 font-display text-h1 text-ink">
                New arrivals
              </h2>
            </div>
            <Link
              href="/search?sort=newest"
              className="text-meta text-blue-600 underline-offset-4 hover:underline"
            >
              Everything, newest first
            </Link>
          </div>
        </Reveal>

        {arrivals.length === 0 ? (
          <p className="mt-6 text-body text-ink/70">
            Nothing new since the batches above. Check back shortly.
          </p>
        ) : (
          <Stagger className="mt-8 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
            {arrivals.map((product) => (
              <StaggerItem key={product.id} className="h-full">
                <ProductCard product={product} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>

      <Assurances />
    </>
  );
}

/**
 * What the price covers, stated plainly at the foot of the page.
 *
 * This is the objection a first-time shopper actually has — that a cheap
 * headline price becomes an expensive one at the door — so it is answered
 * where they will have finished browsing, not buried in a policy page.
 */
function Assurances() {
  const points = [
    {
      icon: IconTag,
      title: "One landed price",
      body: "Shipping from the United States and Bangladeshi customs duty are inside the figure on the listing. The courier asks you for nothing.",
    },
    {
      icon: IconSeal,
      title: "Nothing bought before the window shuts",
      body: "That is why the price holds. If a batch never fills, you are refunded rather than charged for a shipment that did not happen.",
    },
    {
      icon: IconCalendar,
      title: "A stated arrival window",
      body: "Every listing carries the dates we expect it to land, and the order page keeps showing them as it moves through each stage.",
    },
  ];

  return (
    <section className="surface-paper border-t border-ink/10">
      <div className="mx-auto w-full max-w-[1280px] px-4 py-16 md:px-6">
        <Stagger className="grid gap-5 md:grid-cols-3">
          {points.map((point) => (
            <StaggerItem key={point.title} className="h-full">
              {/*
               * Cards with a drawn mark rather than three columns of text
               * separated by hairlines. The band is the last thing on the page
               * and was reading as filler; the icon is what makes each point
               * legible at a glance on the way past.
               */}
              <div className="lift flex h-full flex-col gap-3 rounded-card border border-blue-300 bg-paper p-6 shadow-[var(--shadow-raise)]">
                <span
                  aria-hidden="true"
                  className="inline-flex size-11 items-center justify-center rounded-card border border-blue-300 bg-blue-50 text-blue-600"
                >
                  <point.icon size={22} />
                </span>
                <h2 className="font-display text-h3 text-ink">{point.title}</h2>
                <p className="max-w-[42ch] text-meta text-ink/70">
                  {point.body}
                </p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
