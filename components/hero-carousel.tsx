"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
import { HeroBackdrop } from "./hero-backdrop";
import { IconArrowLeft, IconArrowRight, IconSeal } from "./icons";
import { ProductArt } from "./product-art";

export type HeroSlide = {
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

const INTERVAL_MS = 7000;

/**
 * The front of the shop, as a campaign banner.
 *
 * Built after the owner pointed at a large pharmacy storefront and asked for
 * that shape. What was worth taking from it is structural rather than
 * decorative: a bright, full-bleed promotional band instead of a dark panel;
 * one loud call to action rather than two of equal weight; circular arrows
 * sitting on the outer edges; a rotated sticker in the corner; and the next row
 * of products butting straight up underneath, so the page reads as a shop
 * rather than as a landing page with a shop below it.
 *
 * What was deliberately not taken is the density. That banner is a printed
 * advertisement with four logos and a paragraph of small print in it. This one
 * carries the four things a preorder shopper is actually deciding on — what it
 * is, what it costs, how long the window is open, and how many places are left.
 *
 * Two heroes have been archived under `docs/archive` on the way to this one.
 *
 * Operable before decorative — arrows, dots and thumbnails are real buttons,
 * arrow keys work, rotation stops on hover, focus or any deliberate choice,
 * and it never starts at all for anyone who has asked their system to reduce
 * motion.
 */
export function HeroCarousel({
  slides,
  serverNow,
}: {
  slides: HeroSlide[];
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  /**
   * Set by any deliberate interaction. Hover and focus only pause while they
   * last, which is no use on a touch screen — there, once someone has chosen a
   * slide themselves, the rotation should stop for good rather than moving
   * under their thumb.
   */
  const [takenOver, setTakenOver] = useState(false);
  const dotsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const reduceMotion = useReducedMotion();

  const count = slides.length;

  const go = useCallback(
    (next: number) => {
      setTakenOver(true);
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (paused || takenOver || count < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setIndex((current) => (current + 1) % count);
      }
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, [paused, takenOver, count]);

  if (count === 0) return null;

  const slide = slides[index];

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
      dotsRef.current[(index + 1) % count]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
      dotsRef.current[(index - 1 + count) % count]?.focus();
    }
  }

  /** Real, or absent. A sticker that says nothing advertises nothing. */
  const sticker =
    slide.remaining !== null && slide.remaining > 0
      ? `${slide.remaining} place${slide.remaining === 1 ? "" : "s"} left`
      : null;

  return (
    <section
      className="relative overflow-hidden border-b border-blue-300 bg-paper text-ink"
      aria-roledescription="carousel"
      aria-label="Featured preorders"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      <HeroBackdrop />

      {/*
       * The arrows sit on the outer edges of the band rather than inside the
       * content column — the pattern the reference uses, and the reason it
       * works is that they stay in the same place while the banner behind them
       * changes. Hidden below `lg`, where a swipe is the natural gesture and
       * an arrow overlapping the photograph would only be in the way.
       */}
      {count > 1 ? (
        <>
          <button
            type="button"
            aria-label="Previous product"
            onClick={() => go(index - 1)}
            className="absolute left-3 top-1/2 z-20 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full border border-blue-300 bg-paper/90 text-ink shadow-[var(--shadow-lift)] backdrop-blur transition-colors hover:border-blue-500 hover:text-blue-600 lg:inline-flex"
          >
            <IconArrowLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="Next product"
            onClick={() => go(index + 1)}
            className="absolute right-3 top-1/2 z-20 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full border border-blue-300 bg-paper/90 text-ink shadow-[var(--shadow-lift)] backdrop-blur transition-colors hover:border-blue-500 hover:text-blue-600 lg:inline-flex"
          >
            <IconArrowRight size={20} />
          </button>
        </>
      ) : null}

      <div className="relative mx-auto grid w-full max-w-[1280px] items-center gap-8 px-4 py-10 md:grid-cols-[1.05fr_1fr] md:gap-12 md:px-6 md:py-14 lg:px-16">
        <div className="flex min-w-0 flex-col gap-5">
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
            <span aria-hidden="true" className="h-px w-10 bg-brass" />
            Ordering is open for this batch
          </p>

          {/*
           * The brand statement stays the page's heading — it is what the home
           * page is *about*, and it has to be in the markup a crawler reads
           * with no JavaScript running. The batch beside it is the campaign.
           *
           * Set in CSS rather than with the motion library: Framer writes
           * `opacity: 0` into the server-rendered HTML, which would make the
           * headline of the whole site invisible until JavaScript arrived.
           */}
          <h1 className="max-w-[15ch] font-display text-[clamp(2.25rem,4.6vw,3.5rem)] font-medium leading-[1.04] tracking-[-0.02em] text-ink">
            {["American", "goods,", "landed", "in", "Bangladesh"].map(
              (word, position) => (
                <span
                  key={word}
                  className="animate-rise mr-[0.28ch] inline-block"
                  style={{ animationDelay: `${position * 70}ms` }}
                >
                  {word}
                </span>
              ),
            )}
          </h1>

          <p className="flex max-w-[46ch] items-start gap-2.5 text-body text-ink/70">
            <IconSeal size={20} className="mt-0.5 shrink-0 text-brass-text" />
            One fixed price with shipping and customs duty already inside it.
            Every listing says when the window closes and when it arrives.
          </p>

          {/* Keyed on the slide so the batch re-enters rather than swapping its
              figures silently underneath the same words. */}
          <div key={slide.slug} className="animate-rise flex flex-col gap-5">
            {/* Stacked, not spread. Pushed to the far edge of a wide column the
                price read as belonging to nothing; underneath its own title it
                reads as that batch's price, which is what it is. */}
            <div className="border-t border-blue-300 pt-5">
              {slide.brand ? (
                <p className="text-meta uppercase tracking-[0.12em] text-ink/70">
                  {slide.brand}
                </p>
              ) : null}
              <h2 className="mt-0.5 font-display text-h2 leading-snug text-ink">
                {slide.title}
              </h2>
              <p className="mt-2 font-display text-[1.875rem] font-semibold leading-none tabular-nums text-ink">
                {slide.priceLabel}
              </p>
            </div>

            {slide.closesAt ? (
              <Countdown closesAt={slide.closesAt} serverNow={serverNow} />
            ) : null}

            <div className="max-w-sm">
              <CapacityMeter remaining={slide.remaining} total={slide.total} />
            </div>

            {/*
             * One loud call to action, which is the single clearest thing the
             * reference banner does. The second route out of the hero is a
             * quiet link, not a button competing for the same press.
             */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link
                href={`/products/${slide.slug}`}
                className="surface-brass sheen inline-flex min-h-[3.5rem] items-center rounded-control px-8 text-body font-medium text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
              >
                Preorder this
              </Link>

              <Link
                href="/search?preorder=1"
                className="link-draw text-body font-medium text-blue-600"
              >
                Every open window
              </Link>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col gap-4">
          <div className="relative aspect-[4/3] w-full sm:aspect-[16/11]">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={slide.slug}
                /*
                 * Not branched on reduced motion: it is a gesture rather than
                 * an animation, and the server cannot know the preference, so
                 * branching it renders `touch-action` and `draggable` that the
                 * client then disagrees with.
                 */
                drag={count < 2 ? false : "x"}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.16}
                onDragEnd={(_event, info) => {
                  // A short flick is enough; the threshold is deliberately low
                  // because a slider that ignores a real swipe feels broken.
                  if (info.offset.x < -60) go(index + 1);
                  else if (info.offset.x > 60) go(index - 1);
                }}
                initial={reduceMotion ? false : { opacity: 0, scale: 1.02 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                className="media-zoom surface-studio absolute inset-0 cursor-grab overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-float)] active:cursor-grabbing"
              >
                {slide.imageUrl ? (
                  /* Placeholder media until the storage integration lands. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slide.imageUrl}
                    alt={slide.imageAlt}
                    className="size-full object-cover"
                  />
                ) : (
                  <ProductArt
                    title={slide.title}
                    seed={slide.slug}
                    className="size-full"
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {/*
             * The sticker, pinned to the outer corner of the photograph.
             *
             * On the *inner* corner it sat over the copy column and read as a
             * collision rather than as a label. Out here it is clear of every
             * line of text at every width, which is the whole reason a sticker
             * goes in a corner in the first place.
             */}
            {sticker ? (
              <p
                key={`${slide.slug}-sticker`}
                className="hero-sticker animate-rise absolute -right-3 -top-4 z-10 flex size-[5.5rem] flex-col items-center justify-center rounded-full bg-brass px-2 text-center text-meta font-medium leading-tight text-ink shadow-[var(--shadow-brass)] sm:-right-5 sm:size-24"
              >
                {sticker}
              </p>
            ) : null}
          </div>

          {/*
           * The rest of the featured batch, as a strip. It doubles as the
           * carousel's position indicator on a wide screen, where four small
           * dots are easy to miss.
           */}
          {count > 1 ? (
            <ul className="grid grid-cols-4 gap-2 sm:gap-3">
              {slides.map((entry, position) => (
                <li key={`${entry.slug}-thumb`}>
                  <button
                    type="button"
                    ref={(element) => {
                      dotsRef.current[position] = element;
                    }}
                    onClick={() => go(position)}
                    aria-label={`Show ${entry.title}`}
                    aria-current={position === index ? "true" : undefined}
                    className={`surface-studio block aspect-square w-full overflow-hidden rounded-card border transition-[border-color,opacity,box-shadow] duration-200 ${
                      position === index
                        ? "border-brass opacity-100 shadow-[var(--shadow-raise)]"
                        : "border-blue-300 opacity-70 hover:opacity-100"
                    }`}
                  >
                    {entry.imageUrl ? (
                      /* Placeholder media until storage lands. */
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={entry.imageUrl}
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : (
                      <ProductArt
                        title={entry.title}
                        seed={entry.slug}
                        className="size-full"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
