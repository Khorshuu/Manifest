"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
import { HeroBackdrop } from "./hero-backdrop";
import { IconArrowLeft, IconArrowRight } from "./icons";
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

const HEADLINE = ["American", "goods,", "landed", "in", "Bangladesh"];

/**
 * The front of the shop.
 *
 * Rebuilt around one idea: the left side makes the promise, the right side is
 * the product, and the details of the batch live on a tag pinned across the
 * foot of the photograph rather than stacked under the headline. The previous
 * version put the headline, the subheading, the product name, the price, the
 * countdown, the capacity meter, two buttons and the slide controls into a
 * single column — which left the most important thing on the page, the
 * photograph, as the quieter half of the panel.
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

  return (
    <section
      className="relative overflow-hidden bg-ink-deep text-paper"
      aria-roledescription="carousel"
      aria-label="Featured preorders"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {/* A wall of flaps, stepping over and settling. */}
      <HeroBackdrop />

      {/*
        A scrim between the board and the words. The board is deliberately
        structured rather than faint, so this is what guarantees the headline
        keeps its measured contrast wherever a lit column happens to be.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(58%_74%_at_14%_52%,rgba(10,21,38,0.94),rgba(10,21,38,0.6)_46%,rgba(10,21,38,0.1)_76%)]"
      />

      <div className="relative mx-auto grid w-full max-w-[1280px] items-center gap-10 px-4 py-12 md:grid-cols-[1fr_1.05fr] md:px-6 md:py-16 lg:gap-16">
        <div className="flex min-w-0 flex-col gap-6">
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass">
            <span aria-hidden="true" className="h-px w-10 bg-brass" />
            Ordering is open for this batch
          </p>

          {/*
           * The one gradient headline on the site. A second would make both
           * read as decoration. The words are separate spans purely so they
           * can arrive in sequence; the sentence is a single heading to a
           * screen reader either way.
           */}
          {/*
           * The headline sets itself a word at a time, in CSS.
           *
           * This used to be Framer Motion, and it was wrong twice over. It
           * branched its `initial` prop on `useReducedMotion()`, which the
           * server cannot know — so anyone who had asked for reduced motion
           * hydrated into a mismatch on the `h1` itself. And because Framer
           * writes `opacity: 0` into the server-rendered markup, the headline
           * of the whole site was invisible until JavaScript arrived to take
           * it back.
           *
           * A keyframe has neither problem: identical markup on both sides,
           * it runs without JavaScript, and the reduced-motion block at the
           * end of globals.css collapses it to nothing.
           */}
          <h1 className="text-gradient-paper max-w-[13ch] font-display text-[clamp(2.5rem,5.6vw,4.25rem)] font-medium leading-[1.0] tracking-[-0.02em]">
            {HEADLINE.map((word, position) => (
              <span
                key={word}
                className="animate-rise mr-[0.28ch] inline-block"
                style={{ animationDelay: `${position * 70}ms` }}
              >
                {word}
              </span>
            ))}
          </h1>

          <p className="max-w-[46ch] text-body text-paper/80">
            One fixed price with shipping and customs duty already inside it.
            Every listing says when the window closes and when it arrives.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/products/${slide.slug}`}
              className="surface-brass sheen inline-flex min-h-[3.25rem] items-center rounded-control px-7 text-body font-medium text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
            >
              Preorder this
            </Link>

            <Link
              href="/search?preorder=1"
              className="inline-flex min-h-[3.25rem] items-center rounded-control border border-paper/40 px-6 text-body text-paper transition-colors hover:border-brass hover:text-brass"
            >
              Every open window
            </Link>
          </div>

          {count > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-4 border-t border-paper/15 pt-5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Previous product"
                  onClick={() => go(index - 1)}
                  className="inline-flex size-11 items-center justify-center rounded-control border border-paper/40 text-paper transition-colors hover:border-brass hover:text-brass"
                >
                  <IconArrowLeft size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Next product"
                  onClick={() => go(index + 1)}
                  className="inline-flex size-11 items-center justify-center rounded-control border border-paper/40 text-paper transition-colors hover:border-brass hover:text-brass"
                >
                  <IconArrowRight size={18} />
                </button>
              </div>

              <div
                role="group"
                aria-label="Choose a featured product"
                className="flex items-center gap-2"
              >
                {slides.map((entry, position) => (
                  <button
                    key={entry.slug}
                    ref={(element) => {
                      dotsRef.current[position] = element;
                    }}
                    type="button"
                    aria-label={`Show ${entry.title}`}
                    aria-current={position === index ? "true" : undefined}
                    className={`h-1.5 rounded-card transition-[width,background-color] duration-300 ${
                      position === index
                        ? "w-10 bg-brass"
                        : "w-5 bg-paper/40 hover:bg-paper/70"
                    }`}
                    onClick={() => go(position)}
                  />
                ))}
              </div>

              <p className="font-display text-meta tabular-nums text-paper/70">
                {String(index + 1).padStart(2, "0")} /{" "}
                {String(count).padStart(2, "0")}
              </p>
            </div>
          ) : null}
        </div>

        <div className="relative flex flex-col gap-4">
          <div className="relative aspect-[4/3] w-full sm:aspect-[5/4]">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={slide.slug}
                /*
                 * Not branched on reduced motion, for two reasons. It is a
                 * gesture rather than an animation — asking for stillness is
                 * about what moves on its own, not about having a control
                 * taken away — and the server cannot know the preference, so
                 * branching it here rendered `touch-action` and `draggable` on
                 * the server that the client then disagreed with.
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
                className="media-zoom surface-studio absolute inset-0 cursor-grab overflow-hidden rounded-card border border-paper/20 shadow-[var(--shadow-float)] active:cursor-grabbing"
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
          </div>

          {/*
           * The tag.
           *
           * Everything a shopper is deciding about this batch, on one pale
           * label across the foot of the photograph — the shipping label on a
           * crate. Keyed on the slide so it re-enters rather than swapping its
           * contents silently. It sits below the photograph on a phone, where
           * overlapping it would cover the product.
           */}
          <div
            key={slide.slug}
            /* The brass rule along the top edge is what separates the tag from
               the pale studio ground of the photograph behind it — without it
               the two whites merge and the label stops reading as a separate
               object pinned on. */
            className="animate-rise relative z-10 rounded-card border border-blue-300 border-t-2 border-t-brass bg-paper p-4 text-ink shadow-[var(--shadow-float)] sm:mx-5 sm:-mt-14 sm:p-5"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
              <div className="min-w-0">
                {slide.brand ? (
                  <p className="text-meta uppercase tracking-[0.12em] text-ink/70">
                    {slide.brand}
                  </p>
                ) : null}
                <h2 className="font-display text-h2 leading-snug text-ink">
                  {slide.title}
                </h2>
              </div>
              <p className="font-display text-h2 font-semibold tabular-nums text-ink">
                {slide.priceLabel}
              </p>
            </div>

            {slide.closesAt ? (
              <div className="mt-4 border-t border-blue-200 pt-4">
                <Countdown closesAt={slide.closesAt} serverNow={serverNow} />
              </div>
            ) : null}

            <div className="mt-4">
              <CapacityMeter remaining={slide.remaining} total={slide.total} />
            </div>
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
                    onClick={() => go(position)}
                    aria-label={`Show ${entry.title}`}
                    aria-current={position === index ? "true" : undefined}
                    className={`surface-studio block aspect-square w-full overflow-hidden rounded-card border transition-[border-color,opacity] duration-200 ${
                      position === index
                        ? "border-brass opacity-100"
                        : "border-paper/25 opacity-60 hover:opacity-100"
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
