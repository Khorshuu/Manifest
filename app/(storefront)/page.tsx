import type { Metadata } from "next";
import Link from "next/link";
import { CampaignSlider } from "@/components/campaign-slider";
import { CategoryBento } from "@/components/category-bento";
import { ClosingRail } from "@/components/closing-rail";
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
import { getLiveCampaigns, type LiveCampaign } from "@/lib/homepage";
import { formatBdt } from "@/lib/money";

export const metadata: Metadata = {
  title: "Preorder American goods, delivered in Bangladesh",
  description:
    "Preorder niche American products at a fixed landed price — shipping and customs duty included — with a stated arrival window.",
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [
    campaigns,
    closingSoon,
    newest,
    tree,
    categoryCounts,
    serverNow,
    categoryImages,
  ] = await Promise.all([
    getLiveCampaigns(),
    listClosingSoon(8),
    listProductCards({ sort: "newest", limit: 20 }),
    getCategoryTree(),
    countPublicProductsByCategory(),
    serverInstant(),
    pickCategoryImages(),
  ]);

  /*
   * With no campaign switched on — a new shop, or every slide turned off —
   * the first screen is still a campaign, built from the catalogue: the first
   * product's photograph and the next four as tiles. It is never stored, and
   * the moment staff switch a slide on at /admin/homepage it gives way.
   */
  const catalogue = [...closingSoon, ...newest].filter(
    (product, position, all) =>
      product.imageUrl &&
      all.findIndex((other) => other.id === product.id) === position,
  );
  const slides: LiveCampaign[] =
    campaigns.length > 0
      ? campaigns
      : catalogue[0]
        ? [
            {
              id: "catalogue",
              imageUrl: catalogue[0].imageUrl!,
              focalX: 50,
              focalY: 50,
              heroUrl: `/products/${catalogue[0].slug}`,
              newTab: false,
              title: null,
              text: null,
              cta: null,
              contrast: "auto",
              showcase: catalogue.slice(1, 5).map((product) => ({
                imageUrl: product.imageUrl!,
                title: product.title,
                href: `/products/${product.slug}`,
              })),
            },
          ]
        : [];

  /*
   * The row of new arrivals leaves out what the closing rail already carries,
   * so the page does not say the same thing twice.
   */
  const railSlugs = new Set(closingSoon.map((product) => product.slug));
  const arrivals = newest
    .filter((product) => !railSlugs.has(product.slug))
    .slice(0, 10);

  const priceLabel = (value: number | null) =>
    value === null ? "Price to be confirmed" : formatBdt(value);

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
   * The strip under the campaigns. Every line is a fact about this shop: the
   * lane the goods travel, what the price already covers, and the batches
   * that are genuinely open right now. Nothing on it is a slogan.
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
    // The whole homepage sits on a very light gray-white, so the white
    // showcase cards read as objects on it rather than dissolving into it.
    <div className="home-canvas">
      {/* The page's heading, for a crawler and a screen reader; the slides
          carry their own words when staff give them any. */}
      <h1 className="sr-only">
        Manifest — American goods, delivered in Bangladesh
      </h1>

      {slides.length > 0 ? <CampaignSlider campaigns={slides} /> : null}

      <div className="mt-8 md:mt-10">
        <Ticker items={tickerItems} />
      </div>

      <ClosingRail items={railItems} serverNow={serverNow} />

      <div className="surface-paper border-b border-ink/10 py-12">
        <CategoryBento categories={bentoCategories} />
      </div>

      <section className="mx-auto w-full max-w-[1360px] px-4 py-12 md:px-8">
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-meta font-semibold uppercase tracking-[0.16em] text-brass-text">
                Just listed
              </p>
              <h2 className="mt-1 font-display text-h2 text-ink">
                New arrivals
              </h2>
            </div>
            <Link
              href="/search?sort=newest"
              className="text-meta font-semibold text-blue-600 underline-offset-4 hover:underline"
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
          <Stagger className="product-grid mt-6">
            {arrivals.map((product) => (
              <StaggerItem key={product.id} className="h-full">
                <ProductCard product={product} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>

      <Assurances />
    </div>
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
      <div className="mx-auto w-full max-w-[1360px] px-4 py-12 md:px-8">
        <Stagger className="grid gap-4 md:grid-cols-3">
          {points.map((point) => (
            <StaggerItem key={point.title} className="h-full">
              <div className="lift flex h-full flex-col gap-2 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]">
                <span
                  aria-hidden="true"
                  className="inline-flex size-10 items-center justify-center rounded-card border border-blue-300 bg-blue-50 text-blue-600"
                >
                  <point.icon size={20} />
                </span>
                <h2 className="text-[1.0625rem] font-bold text-ink">{point.title}</h2>
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
