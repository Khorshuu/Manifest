import Link from "next/link";
import { CapacityMeter } from "./capacity-meter";
import { MediaImage } from "./media-image";
import { Countdown } from "./countdown";
import { IconArrowRight } from "./icons";
import { ProductArt } from "./product-art";

export type RailItem = {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  imageAlt: string;
  priceLabel: string;
  closesAt: string | null;
  remaining: number | null;
  total: number | null;
};

/**
 * The batches that shut soonest, nearest closing first.
 *
 * A plain grid rather than a sideways-scrolling row with arrow buttons (the
 * owner asked for the sliders to go): every window is visible at once, and the
 * order still reads left to right, top to bottom.
 */
export function ClosingRail({
  items,
  serverNow,
}: {
  items: RailItem[];
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
}) {
  if (items.length === 0) return null;

  // Tight against the banner above it, so the page reads as a shop rather than
  // as a landing page with a shop somewhere below.
  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 pb-14 pt-10 md:px-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Shutting next
        </p>
        <h2 className="mt-2 font-display text-h1 text-ink">
          Windows closing soon
        </h2>
        <p className="mt-2 max-w-[54ch] text-body text-ink/70">
          When the clock runs out the batch is ordered in the United States
          and the list is fixed. Nothing is added afterwards.
        </p>
      </div>

      <ul
        aria-label="Preorder windows closing soon"
        /*
         * Two across on a phone, like every other listing on the site. One
         * across made each card about half a screen tall and the eight of them
         * four thousand pixels of scrolling before the rest of the homepage
         * began.
         */
        className="mt-6 grid grid-cols-2 gap-2.5 sm:gap-4 md:mt-8 md:grid-cols-3 lg:grid-cols-4 lg:gap-5"
      >
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <Link
              href={`/products/${item.slug}`}
              className="media-zoom lift group flex h-full flex-col gap-2.5 rounded-card border border-blue-300 bg-paper p-2.5 shadow-[var(--shadow-raise)] sm:gap-4 sm:p-4"
            >
              <div className="surface-studio relative aspect-[5/4] w-full overflow-hidden rounded-card">
                {item.imageUrl ? (
                  <MediaImage
                    src={item.imageUrl}
                    alt={item.imageAlt}
                    sizes="(min-width: 1024px) 20vw, (min-width: 768px) 30vw, 45vw"
                    className="object-cover"
                  />
                ) : (
                  <ProductArt
                    title={item.title}
                    seed={item.slug}
                    className="size-full"
                  />
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-0.5">
                {item.brand ? (
                  <span className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ink/70 sm:text-meta sm:font-normal sm:normal-case sm:tracking-normal">
                    {item.brand}
                  </span>
                ) : null}
                <h3 className="line-clamp-2 font-display text-[0.9375rem] font-semibold leading-[1.3] text-ink [overflow-wrap:anywhere] sm:text-h3 sm:leading-snug">
                  {item.title}
                </h3>
              </div>

              {item.closesAt ? (
                <Countdown
                  closesAt={item.closesAt}
                  variant="inline"
                  serverNow={serverNow}
                />
              ) : null}

              <CapacityMeter remaining={item.remaining} total={item.total} />

              <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-blue-200 pt-2 sm:pt-3">
                <p className="font-display text-[1rem] font-semibold tabular-nums text-ink sm:text-price">
                  {item.priceLabel}
                </p>
                <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-blue-600 sm:text-meta">
                  Preorder
                  <IconArrowRight
                    size={16}
                    className="transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-1"
                  />
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
