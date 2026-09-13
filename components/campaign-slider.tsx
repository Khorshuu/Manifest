"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useHeaderTheme } from "./header-theme";
import { MediaImage } from "./media-image";
import { IconArrowRight, IconChevronDown } from "./icons";
import type { LiveCampaign } from "@/lib/homepage/campaigns";
import { detectBackgroundTone, type BackgroundTone } from "@/lib/hero-tone";

/**
 * The homepage's promotional campaigns: one hero photograph and its showcase
 * tiles, as a single slide (DECISIONS.md D-035).
 *
 * The chevrons, a swipe or the arrow keys move the whole unit — photograph,
 * words, destination and every tile together. They are one record rendered
 * from one index, so the hero can never change while the tiles stay put.
 *
 * Composition: the photograph fills about 87% of a desktop screen, the
 * headline and button sit centred over its lower part, and the tiles overlap
 * its foot so the first screen already shows that the campaign continues.
 *
 * It does not rotate on its own; the owner asked for controls, not a timer.
 */
export function CampaignSlider({ campaigns }: { campaigns: LiveCampaign[] }) {
  const [index, setIndex] = useState(0);
  const [measured, setMeasured] = useState<Record<string, BackgroundTone>>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const { report } = useHeaderTheme();

  const count = campaigns.length;
  const current = campaigns[Math.min(index, count - 1)];

  const go = useCallback(
    (step: number) => setIndex((value) => (value + step + count) % count),
    [count],
  );

  /*
   * The header's treatment for the slide in view. `contrast` names the
   * lettering staff chose, so it is the opposite of the background tone; on
   * Automatic the photograph is measured in the browser, once per slide.
   */
  const stated: BackgroundTone | null =
    current.contrast === "light" ? "dark" : current.contrast === "dark" ? "light" : null;
  const tone: BackgroundTone = stated ?? measured[current.id] ?? "dark";

  useEffect(() => {
    if (stated || measured[current.id]) return;
    let live = true;
    detectBackgroundTone(current.imageUrl).then((found) => {
      if (live && found) {
        setMeasured((all) => ({ ...all, [current.id]: found }));
      }
    });
    return () => {
      live = false;
    };
  }, [current.id, current.imageUrl, stated, measured]);

  useEffect(() => {
    report({ tone });
  }, [tone, report]);

  /* The header takes its own bar back as the photograph leaves the screen. */
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

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (count < 2) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  /*
   * A horizontal swipe across the photograph changes slide. A mostly vertical
   * gesture is left alone so the page still scrolls under a thumb.
   */
  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || count < 2) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      go(dx < 0 ? 1 : -1);
    }
  };

  /* A plain chevron in a soft, translucent circle — never a long arrow. */
  const chevronClass =
    "pointer-events-auto inline-flex size-9 items-center justify-center rounded-full bg-[color:var(--hero-arrow-bg)] text-[color:var(--hero-fg)] shadow-[0_2px_10px_rgb(10_21_38/0.18)] ring-1 ring-[color:var(--hero-line)] backdrop-blur-md transition-[transform,background-color] duration-200 hover:scale-105 active:scale-95 md:size-12";

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Promotions"
      onKeyDown={onKeyDown}
      className="campaign relative isolate"
    >
      <div
        ref={stageRef}
        data-tone={tone}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        /*
         * On a desktop the photograph fills most of the screen and the showcase
         * cards sit over its lower edge. The owner set the proportion against a
         * reference: it is sized to about 88% of the screen so the
         * cards overlap its lower edge and still sit on the first screen.
         *
         * Every other width keeps that desktop shape rather than inventing one
         * of its own — the owner asked for the phone to look like the web. A
         * landscape frame (16:9 below `md`), the same row of tiles laid across
         * its foot, overlapping by about the same share of a tile. The `62vw`
         * cap stops a portrait tablet turning the frame upright; on a desktop
         * screen `88svh` is always the smaller of the two, so nothing there
         * changes.
         */
        className="hero-stage relative h-[56.25vw] min-h-[180px] overflow-hidden bg-ink-deep md:h-[max(420px,min(88svh,62vw))] lg:h-[max(600px,min(88svh,62vw))]"
      >
        {campaigns.map((campaign, position) => {
          const active = position === index;
          return (
            <div
              key={campaign.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${position + 1} of ${count}`}
              aria-hidden={!active}
              inert={!active}
              className={`absolute inset-0 transition-opacity duration-700 ease-[var(--ease-out-quint)] motion-reduce:transition-none ${
                active ? "z-[1] opacity-100" : "z-0 opacity-0"
              }`}
            >
              <MediaImage
                src={campaign.imageUrl}
                alt={campaign.title ?? ""}
                // It fills the screen at every width, so there is one candidate
                // per device rather than a desktop photograph on a phone.
                sizes="100vw"
                // The first photograph is the page's largest paint; the others
                // follow once it is in, not in competition with it.
                priority={position === 0}
                fetchPriority={position === 0 ? "high" : "low"}
                className={`object-cover ${active ? "hero-photo" : ""}`}
                objectPosition={`${campaign.focalX}% ${campaign.focalY}%`}
              />

              {/* The whole photograph is the link, laid under the words so the
                  button above it stays its own target. */}
              {campaign.heroUrl ? (
                <Destination
                  href={campaign.heroUrl}
                  newTab={campaign.newTab}
                  className="absolute inset-0 z-[1] focus-visible:outline-offset-[-6px]"
                  label={campaign.title ?? campaign.cta?.label ?? "View this promotion"}
                  tabIndex={campaign.cta ? -1 : 0}
                />
              ) : null}

              {campaign.title || campaign.text || campaign.cta ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] pb-[calc(16vw+1.75rem)] md:pb-[calc(min(19vh,calc((100vw-4rem)*0.146))+3.25rem)] lg:pb-[calc(clamp(7rem,19vh,12rem)+3.25rem)]">
                  <div aria-hidden="true" className="campaign-scrim absolute inset-x-0 bottom-0 h-[55%]" />
                  <div className="relative mx-auto flex w-full max-w-[1000px] flex-col items-center px-12 text-center text-[color:var(--hero-fg)] md:px-20">
                    {campaign.title ? (
                      <h2 className="campaign-title line-clamp-2 text-[clamp(1.0625rem,4.4vw,3.5rem)] font-extrabold leading-[1.04] tracking-[-0.03em] [text-wrap:balance]">
                        {campaign.title}
                      </h2>
                    ) : null}
                    {campaign.text ? (
                      <p className="campaign-title mt-1 line-clamp-1 max-w-[48ch] text-[clamp(0.6875rem,2.6vw,1.125rem)] sm:mt-2.5 md:line-clamp-none font-medium leading-snug text-[color:var(--hero-muted)]">
                        {campaign.text}
                      </p>
                    ) : null}
                    {campaign.cta ? (
                      <Destination
                        href={campaign.cta.href}
                        newTab={campaign.newTab}
                        className="pointer-events-auto mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[color:var(--hero-fg)] px-3.5 text-[0.75rem] sm:mt-4 sm:min-h-10 sm:px-5 sm:text-[0.875rem] font-bold text-[color:var(--campaign-cta-fg)] shadow-[0_4px_14px_rgb(10_21_38/0.2)] transition-transform duration-200 hover:-translate-y-0.5 md:min-h-11 md:px-6 md:text-[0.9375rem]"
                      >
                        {campaign.cta.label}
                        <IconArrowRight size={15} />
                      </Destination>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        <div aria-hidden="true" className="hero-veil pointer-events-none absolute inset-x-0 top-0 z-[3]" />

        {count > 1 ? (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-[4] flex -translate-y-1/2 justify-between px-2.5 md:px-6 lg:px-8">
            <button type="button" onClick={() => go(-1)} className={chevronClass}>
              <IconChevronDown size={20} className="rotate-90 md:size-6" />
              <span className="sr-only">Previous promotion</span>
            </button>
            <button type="button" onClick={() => go(1)} className={chevronClass}>
              <IconChevronDown size={20} className="-rotate-90 md:size-6" />
              <span className="sr-only">Next promotion</span>
            </button>
          </div>
        ) : null}

        {count > 1 ? (
          <div className="absolute inset-x-0 bottom-[calc(16vw+0.5rem)] z-[4] flex justify-center gap-2 md:bottom-[calc(min(19vh,calc((100vw-4rem)*0.146))+1.1rem)] lg:bottom-[calc(clamp(7rem,19vh,12rem)+1.1rem)]">
            {campaigns.map((campaign, position) => (
              <button
                key={campaign.id}
                type="button"
                aria-current={position === index ? "true" : undefined}
                onClick={() => setIndex(position)}
                className={`h-1.5 rounded-full bg-[color:var(--hero-fg)] transition-[width,opacity] duration-300 ${
                  position === index ? "w-6 opacity-100" : "w-1.5 opacity-50 hover:opacity-80"
                }`}
              >
                <span className="sr-only">Show promotion {position + 1}</span>
              </button>
            ))}
          </div>
        ) : null}

        <p aria-live="polite" className="sr-only">
          {count > 1 ? `Promotion ${index + 1} of ${count}` : ""}
        </p>
      </div>

      {current.showcase.length > 0 ? (
        <div className="relative z-10 -mt-[16vw] md:-mt-[min(19vh,calc((100vw-4rem)*0.146))] lg:-mt-[clamp(7rem,19vh,12rem)]">
          <div className="mx-auto w-full max-w-[1280px] px-4 md:px-8">
            {/*
             * Keyed on the campaign, so the row is replaced — and rises in —
             * in the same moment the photograph cross-fades above it. Only
             * the tiles that exist are laid out, centred: three tiles are
             * three cards, never three and an empty slot.
             */}
            <ul
              key={current.id}
              aria-label="Featured in this promotion"
              className="flex justify-center gap-[2vw] md:gap-5"
            >
              {current.showcase.map((tile, position) => (
                <li
                  key={`${current.id}-${position}`}
                  className="animate-rise w-[22.5%] shrink-0 md:w-[min(20%,26vh)]"
                  style={{ animationDelay: `${position * 60}ms` }}
                >
                  <ShowcaseTile tile={tile} newTab={current.newTab} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A showcase card: the tile's own image, whole and centred on a soft
 * gray-white ground, and its custom title underneath. Nothing else — no
 * price, stock or product data.
 */
function ShowcaseTile({
  tile,
  newTab,
}: {
  tile: LiveCampaign["showcase"][number];
  newTab: boolean;
}) {
  const body = (
    <>
      <span className="showcase-well relative flex aspect-square items-center justify-center overflow-hidden rounded-[10px] p-[3%] sm:rounded-[16px] md:rounded-[22px]">
        <MediaImage
          src={tile.imageUrl}
          alt={tile.title ?? ""}
          /* Four tiles across a wide screen, one and a bit on a phone. */
          sizes="(min-width: 768px) 20vw, 25vw"
          className="object-contain p-[3%] transition-transform duration-500 ease-[var(--ease-out-quint)] group-hover:scale-[1.05]"
        />
      </span>
      {tile.title ? (
        <span className="block truncate px-0.5 pb-0.5 pt-1 text-center text-[0.625rem] font-bold leading-tight tracking-[-0.01em] text-ink sm:px-1 sm:pt-2 sm:text-[0.8125rem] md:px-2 md:pb-1 md:pt-2.5 md:text-[1.0625rem]">
          {tile.title}
        </span>
      ) : null}
    </>
  );

  const className =
    "showcase-card group block rounded-[14px] p-1 transition-[transform,box-shadow] duration-300 hover:-translate-y-1 sm:rounded-[20px] sm:p-1.5 md:rounded-[28px] md:p-2";

  return tile.href ? (
    <Destination href={tile.href} newTab={newTab} className={className}>
      {body}
    </Destination>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * A link to wherever staff pointed it: a client-side navigation for a path on
 * this site, an ordinary anchor for another site. A new tab is only ever
 * opened for an external address, and never without `noopener`.
 */
function Destination({
  href,
  newTab,
  className,
  label,
  tabIndex,
  children,
}: {
  href: string;
  newTab: boolean;
  className: string;
  label?: string;
  tabIndex?: number;
  children?: ReactNode;
}) {
  const external = /^https?:\/\//i.test(href);

  if (!external) {
    return (
      <Link href={href} className={className} aria-label={label} tabIndex={tabIndex}>
        {children}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={className}
      aria-label={label}
      tabIndex={tabIndex}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noopener" })}
    >
      {children}
    </a>
  );
}
