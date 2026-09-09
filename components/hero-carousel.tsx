"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
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
 * Dark and full-bleed: the one place the brand takes the whole width, so a
 * first-time visitor lands on something with a point of view rather than on a
 * paragraph. The headline sets itself a word at a time on arrival — one
 * orchestrated moment, which lands harder than movement scattered over the
 * whole page.
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
      className="surface-ink relative overflow-hidden text-paper"
      aria-roledescription="carousel"
      aria-label="Featured preorders"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {/* The ruled-manifest grid, faint, behind everything. */}
      <div
        aria-hidden="true"
        className="grid-rule pointer-events-none absolute inset-0 text-paper opacity-[0.13]"
      />

      <div className="relative mx-auto grid w-full max-w-[1280px] items-center gap-10 px-4 py-14 md:grid-cols-[1.05fr_1fr] md:px-6 md:py-20">
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
          <h1 className="text-gradient-paper max-w-[15ch] font-display text-[clamp(2.5rem,6.2vw,4.5rem)] font-medium leading-[1.02] tracking-[-0.015em]">
            {HEADLINE.map((word, position) => (
              <motion.span
                key={word}
                className="mr-[0.28ch] inline-block"
                initial={reduceMotion ? false : { opacity: 0, y: "0.35em" }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.55,
                  delay: reduceMotion ? 0 : 0.06 * position,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {word}
              </motion.span>
            ))}
          </h1>

          <p className="max-w-[50ch] text-body text-paper/80">
            One fixed price with shipping and customs duty already inside it.
            Every listing says when the window closes and when it arrives.
          </p>

          {/* Keyed on the slide so it re-enters rather than swapping silently. */}
          <div key={slide.slug} className="animate-rise flex flex-col gap-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-paper/20 pt-5">
              <div className="min-w-0 flex-1">
                {slide.brand ? (
                  <p className="text-meta uppercase tracking-[0.12em] text-paper/60">
                    {slide.brand}
                  </p>
                ) : null}
                <h2 className="font-display text-h2 text-paper">
                  {slide.title}
                </h2>
              </div>
              <p className="font-display text-price font-semibold tabular-nums text-brass">
                {slide.priceLabel}
              </p>
            </div>

            {slide.closesAt ? (
              <Countdown
                closesAt={slide.closesAt}
                tone="dark"
                serverNow={serverNow}
              />
            ) : null}

            <div className="max-w-sm">
              <CapacityMeter
                remaining={slide.remaining}
                total={slide.total}
                tone="dark"
              />
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <Link
                href={`/products/${slide.slug}`}
                className="surface-brass sheen inline-flex min-h-12 items-center rounded-control px-6 text-body font-medium text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
              >
                Preorder this
              </Link>

              <Link
                href="/search?preorder=1"
                className="inline-flex min-h-12 items-center rounded-control border border-paper/40 px-5 text-body text-paper transition-colors hover:border-brass hover:text-brass"
              >
                Every open window
              </Link>
            </div>
          </div>

          {count > 1 ? (
            <div className="flex flex-wrap items-center gap-4 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Previous product"
                  onClick={() => go(index - 1)}
                  className="inline-flex size-11 items-center justify-center rounded-control border border-paper/40 text-body text-paper transition-colors hover:border-brass hover:text-brass"
                >
                  <span aria-hidden="true">←</span>
                </button>
                <button
                  type="button"
                  aria-label="Next product"
                  onClick={() => go(index + 1)}
                  className="inline-flex size-11 items-center justify-center rounded-control border border-paper/40 text-body text-paper transition-colors hover:border-brass hover:text-brass"
                >
                  <span aria-hidden="true">→</span>
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
          {/* An offset brass rule behind the image: the printed-form motif. */}
          <div
            aria-hidden="true"
            className="absolute -right-3 -top-3 hidden h-[calc(100%-6rem)] w-full border border-brass/40 md:block"
          />

          <div className="relative aspect-[4/5] w-full sm:aspect-[5/4] md:aspect-[4/5]">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={slide.slug}
                drag={reduceMotion || count < 2 ? false : "x"}
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
           * The rest of the featured batch, as a strip. It doubles as the
           * carousel's position indicator on a wide screen, where four small
           * dots are easy to miss.
           */}
          {count > 1 ? (
            <ul className="grid grid-cols-4 gap-2">
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
