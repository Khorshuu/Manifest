"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
import { IconArrowLeft, IconArrowRight } from "./icons";
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
 * The batches that shut soonest, laid along one axis.
 *
 * They are a queue in time, so they read better as a queue than as a grid: the
 * one nearest closing sits first, and the eye travels rightwards into the ones
 * with more room. It is a real scroll container — a trackpad, a thumb, the
 * arrow keys and the two buttons all move it — rather than a carousel that
 * moves on its own while someone is reading it.
 */
export function ClosingRail({
  items,
  serverNow,
}: {
  items: RailItem[];
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    setAtStart(rail.scrollLeft <= 4);
    // A pixel of slack: fractional widths mean scrollLeft rarely lands exactly.
    setAtEnd(rail.scrollLeft >= max - 4);
  }, []);

  useEffect(() => {
    sync();
    const rail = railRef.current;
    if (!rail) return;
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [sync]);

  function nudge(direction: 1 | -1) {
    const rail = railRef.current;
    if (!rail) return;
    // One tile plus its gap, so a press lands on a tile edge rather than
    // halfway across one.
    const step = rail.firstElementChild?.clientWidth ?? 320;
    rail.scrollBy({ left: direction * (step + 20), behavior: "smooth" });
  }

  if (items.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 py-14 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => nudge(-1)}
            disabled={atStart}
            aria-label="Scroll to earlier windows"
            className="inline-flex size-11 items-center justify-center rounded-control border border-ink/20 text-ink transition-colors hover:border-brass hover:text-brass-text disabled:opacity-40 disabled:hover:border-ink/20 disabled:hover:text-ink"
          >
            <IconArrowLeft size={18} />
          </button>
          <button
            type="button"
            onClick={() => nudge(1)}
            disabled={atEnd}
            aria-label="Scroll to later windows"
            className="inline-flex size-11 items-center justify-center rounded-control border border-ink/20 text-ink transition-colors hover:border-brass hover:text-brass-text disabled:opacity-40 disabled:hover:border-ink/20 disabled:hover:text-ink"
          >
            <IconArrowRight size={18} />
          </button>
        </div>
      </div>

      {/*
       * The fades are the affordance. A tile cut off flat at the edge of the
       * viewport reads as a layout that overflowed; the same tile disappearing
       * under a soft edge reads as a queue that continues — and each one only
       * appears when there is genuinely something in that direction.
       */}
      <div className="relative">
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-paper to-transparent transition-opacity duration-300 ${
            atStart ? "opacity-0" : "opacity-100"
          }`}
        />
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-paper to-transparent transition-opacity duration-300 ${
            atEnd ? "opacity-0" : "opacity-100"
          }`}
        />

        {/*
         * Focusable because it scrolls: a keyboard user has to be able to reach
         * the content that is off to the right without a pointer.
         */}
        <ul
          ref={railRef}
          onScroll={sync}
          tabIndex={0}
          aria-label="Preorder windows closing soon"
          className="rail mt-8 flex snap-x gap-5 overflow-x-auto pb-4"
        >
        {items.map((item) => (
          <li
            key={item.id}
            className="w-[min(78vw,320px)] shrink-0 sm:w-[320px]"
          >
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
      </div>
    </section>
  );
}
