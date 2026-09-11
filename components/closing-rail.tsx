import Link from "next/link";
import { CapacityMeter } from "./capacity-meter";
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
        className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
      >
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <Link
              href={`/products/${item.slug}`}
              className="media-zoom lift group flex h-full flex-col gap-4 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <div className="surface-studio relative aspect-[5/4] w-full overflow-hidden rounded-card">
                {item.imageUrl ? (
                  /* Local seed media; next/image once storage lands. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt={item.imageAlt}
                    width={400}
                    height={320}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                ) : (
                  <ProductArt
                    title={item.title}
                    seed={item.slug}
                    className="size-full"
                  />
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-1">
                {item.brand ? (
                  <span className="text-meta text-ink/70">{item.brand}</span>
                ) : null}
                <h3 className="font-display text-h3 leading-snug text-ink">
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

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-blue-200 pt-3">
                <p className="font-display text-price font-semibold tabular-nums text-ink">
                  {item.priceLabel}
                </p>
                <span className="inline-flex items-center gap-1.5 text-meta font-medium text-blue-600">
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
