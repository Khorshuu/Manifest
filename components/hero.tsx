"use client";

import { useEffect, useRef, useState } from "react";
import { useHeaderTheme } from "./header-theme";
import { ProductArt } from "./product-art";
import type { HeaderContrastMode } from "@/lib/homepage";
import { detectBackgroundTone, type BackgroundTone } from "@/lib/hero-tone";

/** What stands in for a photograph until one is uploaded. */
export type HeroFallback = {
  slug: string;
  title: string;
  imageUrl: string | null;
};

export type HeroContent = {
  imageUrl: string | null;
  focalX: number;
  focalY: number;
  contrast: HeaderContrastMode;
};

/**
 * The front of the shop: one photograph, with the header floating on it and
 * nothing else.
 *
 * It carried a headline, a paragraph, a batch, a price, a capacity meter, a
 * countdown and two links. The owner asked for all of it off the image — "the
 * rest blocking the big image" — so the picture is now unobstructed and the
 * page says what it has to say in the four products directly beneath it, where
 * a name and a price are legible rather than laid over a photograph.
 *
 * There is no rotation, no arrows and no dots. One image, chosen by staff at
 * `/admin/homepage`.
 */
export function Hero({
  content,
  fallback,
}: {
  content: HeroContent;
  /** Only used when no photograph has been uploaded. */
  fallback: HeroFallback | null;
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
   * Before a measurement lands, a photograph is assumed dark and drawn artwork
   * light. That is the likelier answer for each, so the usual case is a
   * measurement confirming the treatment rather than swapping it.
   */
  const tone: BackgroundTone =
    stated ?? measured ?? (content.imageUrl ? "dark" : "light");

  const source = content.imageUrl ?? fallback?.imageUrl ?? null;

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

  return (
    <section className="hero-shell relative isolate" aria-label="Featured photograph">
      <div
        ref={stageRef}
        data-tone={tone}
        /*
         * Roughly four fifths of the first screen. The rest is deliberate: the
         * showcase underneath has to show its own top edge, so a shopper can
         * see there is a shop below the picture without being told.
         */
        className="hero-stage relative min-h-[max(460px,72svh)] overflow-hidden bg-ink-deep lg:min-h-[max(560px,80svh)]"
      >
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
            style={{ objectPosition: `${content.focalX}% ${content.focalY}%` }}
          />
        ) : fallback?.imageUrl ? (
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
              src={fallback.imageUrl}
              alt=""
              fetchPriority="high"
              className="hero-wash absolute inset-0 size-full object-cover"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fallback.imageUrl}
              alt=""
              className="hero-subject absolute inset-x-0 top-[14%] hidden h-[62%] w-full object-contain md:block"
            />
          </>
        ) : fallback ? (
          <div className="hero-subject absolute left-1/2 top-[14%] hidden aspect-square h-[62%] -translate-x-1/2 md:block">
            <ProductArt
              title={fallback.title}
              seed={fallback.slug}
              className="size-full"
            />
          </div>
        ) : null}

        {/* A grade over the image: warm light out of the top right, cool shade
            into the lower left. It is what gives a flat catalogue photograph
            the tonality of a lit scene. */}
        <div aria-hidden="true" className="hero-grade absolute inset-0" />
        {/*
         * A veil at the top only, sized to the header rather than to the copy
         * that used to sit here. The picture below it is untouched, which is
         * the point of taking the words off it.
         */}
        <div aria-hidden="true" className="hero-veil absolute inset-x-0 top-0" />
        <div aria-hidden="true" className="hero-grain absolute inset-0" />
      </div>
    </section>
  );
}
