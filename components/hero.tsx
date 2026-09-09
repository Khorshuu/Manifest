"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CapacityMeter } from "./capacity-meter";
import { Countdown } from "./countdown";
import { useHeaderTheme } from "./header-theme";
import { IconSeal } from "./icons";
import { ProductArt } from "./product-art";
import type { HeaderContrastMode } from "@/lib/homepage";
import { detectBackgroundTone, type BackgroundTone } from "@/lib/hero-tone";

/** The batch the hero prices. Null when the shop has nothing to feature. */
export type HeroFeature = {
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  imageAlt: string;
  priceLabel: string;
  availability: string;
  arrival: string | null;
  closesAt: string | null;
  remaining: number | null;
  total: number | null;
  closingSoon: boolean;
};

export type HeroContent = {
  imageUrl: string | null;
  focalX: number;
  focalY: number;
  contrast: HeaderContrastMode;
  eyebrow: string;
  headline: string;
  support: string;
  ctaLabel: string;
  ctaHref: string;
};

/**
 * The front of the shop: one photograph, the header drawn straight over it,
 * and the featured batch priced on top of it.
 *
 * There is no rotation. The hero that stood here rotated through five batches,
 * and the owner's brief for this redesign rules that out: one image, chosen by
 * staff, holding the first screen. What the carousel was also doing — proving
 * the shop has more than one thing in it — is now done by the showcase
 * directly underneath, which is a better place for it, because those cards
 * carry a price and a name rather than being a position indicator.
 *
 * Everything on it is real: the photograph and the words come from
 * `site_settings` where staff put them, and the product block is a live
 * catalogue row. Nothing here is hard-coded copy about a product.
 */
export function Hero({
  content,
  feature,
  serverNow,
}: {
  content: HeroContent;
  feature: HeroFeature | null;
  /** The instant the server rendered at — see Countdown. */
  serverNow: number;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { report } = useHeaderTheme();

  /*
   * What the browser measured, if it was asked to. `contrast` names the
   * lettering an editor chose; the tone here names the *background*, so the
   * two are opposites — see lib/homepage/hero.ts.
   */
  const [measured, setMeasured] = useState<BackgroundTone | null>(null);
  const stated: BackgroundTone | null =
    content.contrast === "light"
      ? "dark"
      : content.contrast === "dark"
        ? "light"
        : null;

  /*
   * Before a measurement lands, a photograph is assumed dark and drawn
   * artwork light. That is the likelier answer for each, so the usual case is
   * a measurement confirming the treatment rather than swapping it.
   */
  const tone: BackgroundTone =
    stated ?? measured ?? (content.imageUrl ? "dark" : "light");

  const source = content.imageUrl ?? feature?.imageUrl ?? null;

  useEffect(() => {
    if (stated || !source) return;

    let live = true;
    detectBackgroundTone(source).then((found) => {
      if (live && found) setMeasured(found);
    });

    return () => {
      live = false;
    };
  }, [source, stated]);

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
      report({ scrolledPast: stage.getBoundingClientRect().bottom <= 96 });
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [report]);

  const dark = tone === "dark";
  const ctaHref =
    content.ctaHref ||
    (feature ? `/products/${feature.slug}` : "/search?preorder=1");

  return (
    <section className="hero-shell relative isolate" aria-label="Featured batch">
      <div
        ref={stageRef}
        data-tone={tone}
        /*
         * Roughly four fifths of the first screen. The rest is deliberate: the
         * showcase underneath has to show its own top edge, so a shopper can
         * see there is a shop below the picture without being told.
         */
        className="hero-stage relative flex min-h-[max(560px,78svh)] flex-col justify-end overflow-hidden bg-ink-deep pb-[clamp(7rem,16vh,11rem)] pt-[calc(var(--header-h)+1rem)] text-[color:var(--hero-fg)] lg:min-h-[max(620px,84svh)] lg:pb-[clamp(8rem,18vh,13rem)]"
      >
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          {content.imageUrl ? (
            /*
             * A photograph was composed by whoever took it, so it is laid in
             * edge to edge with nothing but a slow drift over it. The focal
             * point staff chose decides what survives a crop on a narrow
             * screen — `object-position`, not a hard-coded centre.
             */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={content.imageUrl}
              alt=""
              /* The largest thing on the first screen: it is the LCP element,
                 and it must not wait behind anything below the fold. */
              fetchPriority="high"
              decoding="async"
              className="hero-photo absolute inset-0 size-full object-cover"
              style={{
                objectPosition: `${content.focalX}% ${content.focalY}%`,
              }}
            />
          ) : feature?.imageUrl ? (
            <>
              {/*
               * No photograph uploaded yet. The catalogue image stands in, in
               * two layers: a blurred, over-scaled copy that gives the whole
               * screen the product's own colour, and the sharp subject held to
               * one side of it. That pair is what lets a square catalogue shot
               * hold a wide screen without being cropped to a stripe.
               */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={feature.imageUrl}
                alt=""
                fetchPriority="high"
                className="hero-wash absolute inset-0 size-full object-cover"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={feature.imageUrl}
                alt=""
                className="hero-subject absolute inset-x-0 top-[6%] hidden h-[20%] w-full object-contain md:block lg:inset-x-auto lg:right-[2%] lg:top-[12%] lg:h-[62%] lg:w-[44%]"
              />
            </>
          ) : feature ? (
            <div className="hero-subject absolute left-1/2 top-[6%] hidden aspect-square h-[20%] -translate-x-1/2 md:block lg:left-auto lg:right-[5%] lg:top-[14%] lg:h-[58%] lg:translate-x-0">
              <ProductArt
                title={feature.title}
                seed={feature.slug}
                className="size-full"
              />
            </div>
          ) : null}
        </div>

        {/* A grade over the image before anything else: warm light out of the
            top right, cool shade into the lower left. */}
        <div aria-hidden="true" className="hero-grade absolute inset-0" />
        {/* The one overlay: a wash from the corner the words sit in, sized so
            the photograph itself is never flatly darkened. */}
        <div aria-hidden="true" className="hero-scrim absolute inset-0" />
        <div aria-hidden="true" className="hero-grain absolute inset-0" />

        <div className="relative z-10 mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-4 md:px-8">
          <div className="flex max-w-[36rem] flex-col gap-4">
            {content.eyebrow ? (
              <p className="animate-rise flex items-center gap-3 text-meta font-semibold uppercase tracking-[0.2em]">
                <span aria-hidden="true" className="h-px w-10 bg-brass" />
                {content.eyebrow}
              </p>
            ) : null}

            {/*
             * The brand statement is the page's heading, and it has to be in
             * the markup a crawler reads with no JavaScript running — so the
             * entrance is a CSS animation rather than a motion library, which
             * would write `opacity: 0` into the server-rendered HTML.
             */}
            <h1 className="max-w-[15ch] font-display text-[clamp(2.5rem,6.2vw,4.75rem)] font-extrabold leading-[0.98] tracking-[-0.035em]">
              {content.headline.split(" ").map((word, position) => (
                <span
                  key={`${word}-${position}`}
                  className="animate-rise mr-[0.24ch] inline-block"
                  style={{ animationDelay: `${position * 60}ms` }}
                >
                  {word}
                </span>
              ))}
            </h1>

            {content.support ? (
              <p className="flex max-w-[46ch] items-start gap-2.5 text-body text-[color:var(--hero-muted)]">
                <IconSeal size={20} className="mt-0.5 shrink-0 text-brass" />
                {content.support}
              </p>
            ) : null}
          </div>

          {/*
           * The batch, its price and the call to action — all of it above the
           * foot of the image on purpose. A price at the very bottom of a
           * full-screen photograph is a price nobody sees.
           */}
          {feature ? (
            <div className="animate-rise flex max-w-[36rem] flex-col gap-3.5 border-t border-[color:var(--hero-line)] pt-5">
              <div className="min-w-0">
                {feature.brand ? (
                  <p className="text-meta font-semibold uppercase tracking-[0.14em] text-[color:var(--hero-muted)]">
                    {feature.brand}
                  </p>
                ) : null}
                <p className="mt-1 font-display text-h2 leading-tight">
                  {feature.title}
                </p>
                <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-display text-[2rem] font-extrabold leading-none tabular-nums">
                    {feature.priceLabel}
                  </span>
                  <span className="text-meta text-[color:var(--hero-muted)]">
                    {feature.availability}
                    {feature.arrival ? ` · arrives ${feature.arrival}` : ""}
                  </span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                <div className="min-w-[14rem] max-w-sm flex-1">
                  <CapacityMeter
                    remaining={feature.remaining}
                    total={feature.total}
                    tone={dark ? "dark" : "light"}
                  />
                </div>

                {feature.closesAt ? (
                  <Countdown
                    closesAt={feature.closesAt}
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
                  href={ctaHref}
                  className="surface-brass sheen inline-flex min-h-[3.5rem] items-center rounded-control px-9 text-body font-bold text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
                >
                  {content.ctaLabel}
                </Link>

                <Link
                  href="/search?preorder=1"
                  className="link-draw text-body font-semibold"
                >
                  Every open window
                </Link>
              </div>
            </div>
          ) : (
            <div className="animate-rise flex flex-wrap items-center gap-x-7 gap-y-3 border-t border-[color:var(--hero-line)] pt-5">
              <Link
                href={ctaHref}
                className="surface-brass sheen inline-flex min-h-[3.5rem] items-center rounded-control px-9 text-body font-bold text-ink shadow-[var(--shadow-raise)] transition-[box-shadow,transform,filter] duration-150 hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04] active:scale-[0.985]"
              >
                {content.ctaLabel}
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
