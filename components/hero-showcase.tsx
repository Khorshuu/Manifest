"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
import { useHeaderTheme } from "./header-theme";
import { IconArrowLeft, IconArrowRight, IconSeal } from "./icons";
import { ProductArt } from "./product-art";
import { detectBackgroundTone, type BackgroundTone } from "@/lib/hero-tone";

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
  /** "Preorder open", "In stock" — the state as the catalogue states it. */
  availability: string;
  /** The dates this batch is expected to land, already formatted. */
  arrival: string | null;
  /** The database's own judgement, not a clock read in the browser. */
  closingSoon: boolean;
  /**
   * A stated answer for how light this slide is, where measuring it gets the
   * wrong one. Null means measure it — see lib/hero-tone.ts.
   */
  tone: BackgroundTone | null;
};

const INTERVAL_MS = 7000;

/**
 * The front of the shop: one immersive photograph, the header drawn straight
 * over it, and the featured batch attached to its bottom edge.
 *
 * The composition is deliberately editorial rather than promotional. The
 * photograph fills the first screen; the copy sits low and left over it; the
 * curated row underneath overlaps the foot of the image, so the page reads as
 * one thing rather than as a banner with a shop somewhere below it. Choosing a
 * product in that row drives the hero, and the hero drives it back.
 *
 * Three earlier heroes are archived under `docs/archive`, and the lesson they
 * left is still the governing one here: **scale beats incident.** There is one
 * large slow movement (the image drifts as it settles) and nothing small,
 * fast or faint anywhere.
 *
 * Operable before decorative — arrows, cards and the rail are real buttons,
 * arrow keys work, rotation stops on hover, focus or any deliberate choice,
 * and it never starts at all for anyone who has asked to reduce motion.
 */
export function HeroShowcase({
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
  /** What each slide measured, once the browser has looked at the image. */
  const [measured, setMeasured] = useState<Record<string, BackgroundTone>>({});
  const cardsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLUListElement>(null);
  /** Where a finger landed on the photograph, so a flick can move the slide. */
  const swipeFrom = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();
  const { report } = useHeaderTheme();

  const count = slides.length;
  const slide = count > 0 ? slides[index] : null;
  const tone: BackgroundTone =
    slide?.tone ?? (slide ? (measured[slide.slug] ?? "light") : "light");

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

  /*
   * Measure every slide once, rather than only the one on screen: the answer is
   * wanted at the moment the slide changes, and a measurement that arrives
   * after the crossfade would show as the header changing its mind.
   */
  useEffect(() => {
    let live = true;

    (async () => {
      for (const entry of slides) {
        if (entry.tone || !entry.imageUrl) continue;
        const found = await detectBackgroundTone(entry.imageUrl);
        if (!live || !found) continue;
        setMeasured((current) =>
          current[entry.slug] === found
            ? current
            : { ...current, [entry.slug]: found },
        );
      }
    })();

    return () => {
      live = false;
    };
  }, [slides]);

  /** Tell the header what it is sitting on. */
  useEffect(() => {
    report({ tone });
  }, [tone, report]);

  /*
   * And tell it when the photograph has gone. The threshold is the foot of the
   * stage rather than a fixed number of pixels, so the header takes its own
   * surface back exactly as the image leaves rather than partway down it.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onScroll = () => {
      const bottom = stage.getBoundingClientRect().bottom;
      report({ scrolledPast: bottom <= 96 });
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [report]);

  /** Keep the chosen card in view when the rotation, not a finger, moved it. */
  useEffect(() => {
    const rail = railRef.current;
    const card = cardsRef.current[index];
    if (!rail || !card) return;
    if (rail.scrollWidth <= rail.clientWidth + 4) return;

    const left = card.offsetLeft - rail.offsetLeft - 16;
    rail.scrollTo({
      left,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [index, reduceMotion]);

  if (!slide) return null;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
      cardsRef.current[(index + 1) % count]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
      cardsRef.current[(index - 1 + count) % count]?.focus();
    }
  }

  /* Real, or absent. An eyebrow that says nothing announces nothing. */
  const eyebrow = slide.closingSoon
    ? "This batch closes shortly"
    : slide.remaining !== null && slide.remaining <= 0
      ? "This batch is full"
      : "Ordering is open for this batch";

  const dark = tone === "dark";

  return (
    <section
      className="hero-shell relative isolate"
      aria-roledescription="carousel"
      aria-label="Featured preorders"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      <div
        ref={stageRef}
        data-tone={tone}
        /*
         * A flick moves the slide, on the surface the gesture belongs to. Touch
         * and pen only: dragging with a mouse across a page is how text gets
         * selected, and stealing that would be worse than the gesture is worth.
         * Nothing is prevented, so a vertical swipe still scrolls the page.
         */
        onPointerDown={(event) => {
          swipeFrom.current =
            event.pointerType === "mouse" ? null : event.clientX;
        }}
        onPointerUp={(event) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null || count < 2) return;

          // Deliberately short: a slider that ignores a real swipe feels broken.
          const travelled = event.clientX - from;
          if (travelled < -56) go(index + 1);
          else if (travelled > 56) go(index - 1);
        }}
        onPointerCancel={() => {
          swipeFrom.current = null;
        }}
        className="hero-stage relative flex min-h-[max(600px,84svh)] flex-col justify-end overflow-hidden bg-ink-deep pb-[8.5rem] pt-[calc(var(--header-h)+1rem)] text-[color:var(--hero-fg)] sm:pb-[10rem] lg:min-h-[max(660px,90svh)] lg:pb-[11.5rem]"
      >
        {/*
         * The imagery, in two layers taken from the same photograph: a blurred
         * copy scaled past the edges, which gives the whole screen the colour
         * of the product rather than a flat panel, and the sharp subject held
         * to the right of it.
         *
         * The pair is what lets a square catalogue photograph fill a wide
         * screen without being cropped to a stripe of itself.
         */}
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          <AnimatePresence initial={false}>
            <motion.div
              key={slide.slug}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
            >
              {slide.imageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={slide.imageUrl}
                    alt=""
                    className="hero-wash absolute inset-0 size-full object-cover"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={slide.imageUrl}
                    alt=""
                    /*
                     * Beside the words on a wide screen, above them on a
                     * tablet, and absent on a phone.
                     *
                     * A phone screen is exactly as tall as the words need. A
                     * subject placed anywhere on it lands behind the headline,
                     * which is worse than not having one — and nothing is
                     * lost, because the blurred wash still carries the
                     * product's own colour across the whole screen and the
                     * card resting on the foot of the image carries the
                     * product itself, at size.
                     */
                    className="hero-subject absolute inset-x-0 top-[5%] hidden h-[22%] w-full object-contain md:block lg:inset-x-auto lg:right-0 lg:top-[8%] lg:h-[72%] lg:w-[48%]"
                  />
                </>
              ) : (
                <div className="hero-subject absolute left-1/2 top-[5%] hidden aspect-square h-[22%] -translate-x-1/2 md:block lg:left-auto lg:right-[4%] lg:top-[10%] lg:h-[64%] lg:translate-x-0">
                  <ProductArt
                    title={slide.title}
                    seed={slide.slug}
                    className="size-full"
                  />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* A grade over the image before anything else: warm light out of the
            top right, cool shade into the lower left. It is what gives a flat
            catalogue photograph the tonality of a lit scene. */}
        <div aria-hidden="true" className="hero-grade absolute inset-0" />

        {/* The one overlay: a wash from the corner the words sit in, sized so
            the photograph itself is never flatly darkened. */}
        <div aria-hidden="true" className="hero-scrim absolute inset-0" />
        <div aria-hidden="true" className="hero-grain absolute inset-0" />

        {/*
         * How far through the rotation this slide is, drawn as a hairline
         * across the top of the stage. It answers the one question a rotating
         * hero raises — "is this about to move?" — without four dots of
         * furniture, and it stops the moment anyone takes the slider over.
         */}
        {count > 1 ? (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 z-10 h-px bg-[color:var(--hero-line)]"
          >
            <span
              key={`${slide.slug}-progress`}
              data-running={paused || takenOver ? "false" : "true"}
              className="hero-progress block h-px w-full origin-left bg-brass"
              style={{ animationDuration: `${INTERVAL_MS}ms` }}
            />
          </div>
        ) : null}

        {/*
         * Everything reads down one column on the left, which is what keeps the
         * right-hand half of the photograph clear of type. The column is capped
         * well short of the page so the words never run under the product.
         */}
        <div className="relative z-10 mx-auto flex w-full max-w-[1360px] flex-col gap-7 px-4 md:px-8 lg:max-w-[1360px]">
          <div className="flex max-w-[34rem] flex-col gap-5">
            <p
              key={`${slide.slug}-eyebrow`}
              className="animate-rise flex items-center gap-3 text-meta uppercase tracking-[0.22em]"
            >
              <span aria-hidden="true" className="h-px w-10 bg-brass" />
              {eyebrow}
            </p>

            {/*
             * The brand statement stays the page's heading — it is what the
             * home page is *about*, and it has to be in the markup a crawler
             * reads with no JavaScript running. The batch beside it is the
             * campaign.
             *
             * Set in CSS rather than with the motion library: Framer writes
             * `opacity: 0` into the server-rendered HTML, which would make the
             * headline of the whole site invisible until JavaScript arrived.
             */}
            <h1 className="max-w-[16ch] font-display text-[clamp(2.5rem,6vw,4.75rem)] font-medium leading-[0.98] tracking-[-0.025em]">
              {["American", "goods,", "landed", "in", "Bangladesh"].map(
                (word, position) => (
                  <span
                    key={word}
                    className="animate-rise mr-[0.26ch] inline-block"
                    style={{ animationDelay: `${position * 70}ms` }}
                  >
                    {word}
                  </span>
                ),
              )}
            </h1>

            <p className="flex max-w-[46ch] items-start gap-2.5 text-body text-[color:var(--hero-muted)]">
              <IconSeal size={20} className="mt-0.5 shrink-0 text-brass" />
              One fixed price with shipping and customs duty already inside it.
              Every listing says when the window closes and when it arrives.
            </p>
          </div>

          {/* Keyed on the slide so the batch re-enters rather than swapping its
              figures silently underneath the same words. */}
          <div
            key={slide.slug}
            className="animate-rise flex max-w-[34rem] flex-col gap-4 border-t border-[color:var(--hero-line)] pt-5"
          >
            <div className="min-w-0">
              {slide.brand ? (
                <p className="text-meta uppercase tracking-[0.14em] text-[color:var(--hero-muted)]">
                  {slide.brand}
                </p>
              ) : null}
              <h2 className="mt-1 font-display text-h2 leading-tight">
                {slide.title}
              </h2>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-display text-[1.75rem] font-semibold leading-none tabular-nums">
                  {slide.priceLabel}
                </span>
                <span className="text-meta text-[color:var(--hero-muted)]">
                  {slide.availability}
                  {slide.arrival ? ` · arrives ${slide.arrival}` : ""}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="min-w-[14rem] max-w-sm flex-1">
                <CapacityMeter
                  remaining={slide.remaining}
                  total={slide.total}
                  tone={dark ? "dark" : "light"}
                />
              </div>

              {slide.closesAt ? (
                <Countdown
                  closesAt={slide.closesAt}
                  variant="inline"
                  tone={dark ? "dark" : "light"}
                  serverNow={serverNow}
                />
              ) : null}
            </div>

            {/*
             * One loud call to action. The second route out of the hero is a
             * quiet link, not a button competing for the same press.
             */}
            <div className="mt-1 flex flex-wrap items-center gap-x-7 gap-y-3">
              <Link
                href={`/products/${slide.slug}`}
                className="surface-brass sheen inline-flex min-h-[3.5rem] items-center rounded-control px-9 text-body font-medium text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
              >
                Preorder this
              </Link>

              <Link
                href="/search?preorder=1"
                className="link-draw text-body font-medium"
              >
                Every open window
              </Link>
            </div>
          </div>
        </div>

        {/*
         * The controls, as one cluster in the lower right rather than two
         * arrows floating on the outer edges. Out there they crossed the copy
         * at some widths and the product at others; here they sit in the one
         * corner of the photograph that is deliberately kept empty, beside the
         * count they act on.
         */}
        {count > 1 ? (
          <div className="absolute bottom-[9.5rem] right-4 z-20 hidden items-center gap-3 md:right-8 lg:bottom-[14rem] lg:flex">
            <button
              type="button"
              aria-label="Previous product"
              onClick={() => go(index - 1)}
              className="hero-arrow inline-flex size-12 items-center justify-center rounded-full"
            >
              <IconArrowLeft size={20} />
            </button>

            <p className="min-w-[4.5rem] text-center text-meta tabular-nums text-[color:var(--hero-muted)]">
              <span className="text-[color:var(--hero-fg)]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span aria-hidden="true"> / {String(count).padStart(2, "0")}</span>
              <span className="sr-only">{` of ${count} featured products`}</span>
            </p>

            <button
              type="button"
              aria-label="Next product"
              onClick={() => go(index + 1)}
              className="hero-arrow inline-flex size-12 items-center justify-center rounded-full"
            >
              <IconArrowRight size={20} />
            </button>
          </div>
        ) : null}
      </div>

      {/*
       * The curated row, lifted onto the foot of the photograph so the two read
       * as one composition. It is also the carousel's position indicator: four
       * cards state what is in the batch, where four dots would state nothing.
       */}
      <div className="relative z-20 -mt-[5.5rem] sm:-mt-[6.5rem] lg:-mt-[8.5rem]">
        <ul
          ref={railRef}
          className="rail mx-auto flex w-full max-w-[1360px] gap-3 overflow-x-auto px-4 pb-4 md:gap-4 md:px-8"
        >
          {slides.map((entry, position) => {
            const active = position === index;
            const soldOut = entry.remaining !== null && entry.remaining <= 0;

            return (
              <li
                key={`${entry.slug}-card`}
                /*
                 * The entrance lives on the row item rather than on the card:
                 * the card holds a transform of its own while it is the active
                 * one, and an animation with a `both` fill would hold that
                 * transform at its own end state for good.
                 */
                className="animate-rise w-[70%] shrink-0 sm:w-[46%] lg:w-[calc((100%-3rem)/4)]"
                style={{ animationDelay: `${position * 70}ms` }}
              >
                <button
                  type="button"
                  ref={(element) => {
                    cardsRef.current[position] = element;
                  }}
                  onClick={() => go(position)}
                  aria-label={`Show ${entry.title}`}
                  aria-current={active ? "true" : undefined}
                  className={`showcase-card media-zoom group block w-full overflow-hidden rounded-card border bg-paper text-left transition-[transform,box-shadow,border-color] duration-300 ease-[var(--ease-out-quint)] ${
                    active
                      ? "border-brass shadow-[var(--shadow-float)] lg:-translate-y-2"
                      : "border-blue-300 shadow-[var(--shadow-raise)] hover:-translate-y-1 hover:border-blue-500 hover:shadow-[var(--shadow-lift)]"
                  }`}
                >
                  <span className="surface-studio relative block aspect-[4/3] w-full overflow-hidden">
                    {entry.imageUrl ? (
                      /* Placeholder media until the storage integration lands. */
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

                    {active ? (
                      <span className="animate-rise absolute left-3 top-3 rounded-card bg-brass px-2 py-1 text-meta font-medium text-ink shadow-[var(--shadow-raise)]">
                        Showing
                      </span>
                    ) : null}
                  </span>

                  <span className="flex flex-col gap-1.5 p-4">
                    {entry.brand ? (
                      <span className="text-meta uppercase tracking-[0.12em] text-ink/70">
                        {entry.brand}
                      </span>
                    ) : null}

                    <span className="font-display text-h3 leading-snug text-ink [overflow-wrap:anywhere]">
                      {entry.title}
                    </span>

                    <span className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-blue-200 pt-3">
                      <span className="font-display text-price font-semibold tabular-nums text-ink">
                        {entry.priceLabel}
                      </span>
                      <span
                        className={`text-meta ${
                          soldOut
                            ? "text-stamp-red-text"
                            : entry.closingSoon
                              ? "text-brass-text"
                              : "text-ink/70"
                        }`}
                      >
                        {soldOut
                          ? "Batch full"
                          : entry.closingSoon
                            ? "Closing soon"
                            : entry.remaining !== null
                              ? `${entry.remaining} places left`
                              : entry.availability}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
