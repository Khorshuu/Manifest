"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconPlay } from "@/components/icons";
import { MediaImage } from "@/components/media-image";

export type GalleryImage = { id: string; url: string; altText: string };

/*
 * The full-screen viewer, with its pinch zoom, is fetched the first time a
 * shopper reaches for a photograph rather than with the page.
 */
const GalleryViewer = dynamic(() => import("./gallery-viewer"), { ssr: false });

/** Starts the viewer's download early; the press itself retries a failure. */
function preloadViewer() {
  import("./gallery-viewer").catch(() => {});
}

/**
 * The product media, as a shopper actually uses it.
 *
 * Every photograph sits side by side in one track that scrolls sideways and
 * settles on a photograph (D-046). On a phone that track *is* the gallery: a
 * swipe moves to the next shot with the browser's own momentum, and a row of
 * small dots under it says where you are. There are no arrow buttons on a
 * phone — the owner ruled them out, and a thumb swipes anyway.
 *
 * From `lg` the same track is locked and driven by the thumbnails, jumping
 * rather than sliding and fading the new shot in, so the desktop reads exactly
 * as it did: thumbnails as buttons, a hover magnifier on the photograph, and a
 * click for the full-screen viewer.
 *
 * Touch devices never see the hover zoom: there is no cursor to follow, so
 * the tap opens the viewer instead, which is the touch-friendly equivalent.
 */

export type MediaItem =
  | { kind: "image"; id: string; url: string; altText: string }
  | { kind: "video"; id: string; url: string; altText: string };

/** The embeddable form of a YouTube or Vimeo link, or null for a plain file. */
function embedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "youtu.be") {
      const id = parsed.pathname.slice(1);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "vimeo.com") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function VideoFrame({ url, title }: { url: string; title: string }) {
  const embed = embedUrl(url);

  if (embed) {
    return (
      <iframe
        src={embed}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
        allowFullScreen
        className="size-full"
      />
    );
  }

  return (
    /* A link the browser can play directly. `controls` rather than autoplay:
       a product page that starts making noise is a page people leave. */
    <video src={url} controls className="size-full bg-ink-deep object-contain">
      <a href={url}>{title}</a>
    </video>
  );
}

/** The media query the desktop gallery is drawn from — `lg` in Tailwind. */
const DESKTOP = "(min-width: 1024px)";

/**
 * Edge to edge below `lg`, as in the owner's reference (D-047): the frame
 * steps out of the page gutter and loses its card border, so the photograph
 * is the width of the phone.
 */
const BLEED =
  "max-md:-mx-4 max-md:w-[calc(100%+2rem)] md:max-lg:-mx-6 md:max-lg:w-[calc(100%+3rem)] max-lg:rounded-none max-lg:border-0 max-lg:shadow-none";

export function Gallery({
  images,
  title,
  videoUrl,
  overlay,
  placeholder,
}: {
  images: GalleryImage[];
  title: string;
  videoUrl?: string | null;
  /** Controls drawn over the photograph — the phone's back, share and save. */
  overlay?: ReactNode;
  /**
   * What stands in when there is no photograph or video, drawn by the server
   * so the artwork's code is not sent to the browser.
   */
  placeholder?: ReactNode;
}) {
  // A variant's own photograph (sent by the variant picker when it is
  // chosen). Shown first when it is not already one of the gallery images.
  const [variantPhoto, setVariantPhoto] = useState<string | null>(null);
  const extra =
    variantPhoto && !images.some((image) => image.url === variantPhoto)
      ? [{ ...images[0], id: "variant-photo", url: variantPhoto, altText: `${title}, selected option` }]
      : [];
  const items: MediaItem[] = [
    ...[...extra, ...images].map((image) => ({ kind: "image" as const, ...image })),
    ...(videoUrl
      ? [
          {
            kind: "video" as const,
            id: "video",
            url: videoUrl,
            altText: `Video of ${title}`,
          },
        ]
      : []),
  ];

  const [index, setIndex] = useState(0);
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [open, setOpen] = useState(false);
  /** Read after mount only: the server renders the phone's track. */
  const [desktop, setDesktop] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onVariant = (event: Event) => {
      const url = (event as CustomEvent<{ imageUrl: string | null }>).detail?.imageUrl;
      if (!url) return;
      setVariantPhoto(url);
      const found = images.findIndex((image) => image.url === url);
      setIndex(found >= 0 ? found : 0);
    };
    window.addEventListener("product:variant-selected", onVariant);
    return () => window.removeEventListener("product:variant-selected", onVariant);
  }, [images]);

  const count = items.length;
  const step = useCallback(
    (delta: number) => setIndex((current) => (current + delta + count) % count),
    [count],
  );

  /*
   * The track follows the index whenever something other than a swipe moved
   * it — a dot, a thumbnail, the chosen variant, the viewer. A swipe updates
   * the index from the scroll position, so by the time this runs the track is
   * already there and nothing moves.
   */
  useEffect(() => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const showing = Math.round(track.scrollLeft / track.clientWidth);
    if (showing === index) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({
      left: index * track.clientWidth,
      behavior: desktop || reduce ? "instant" : "smooth",
    });
  }, [index, desktop]);

  // Stable, so the viewer's keyboard binding is not torn down every render.
  const closeViewer = useCallback(() => setOpen(false), []);

  if (count === 0) {
    return (
      <div data-product-photo className={`surface-studio relative aspect-square max-h-[62svh] w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)] lg:max-h-none ${BLEED}`}>
        {placeholder}
        {overlay}
      </div>
    );
  }

  const safeIndex = Math.min(index, count - 1);
  const active = items[safeIndex];

  function trackCursor(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setOrigin({
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    });
  }

  /** A swipe settles the index on whichever photograph is mostly in view. */
  function onTrackScroll(event: React.UIEvent<HTMLDivElement>) {
    const track = event.currentTarget;
    if (track.clientWidth === 0) return;
    const showing = Math.round(track.scrollLeft / track.clientWidth);
    if (showing !== index && showing >= 0 && showing < count) setIndex(showing);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        /*
         * Square on a desktop. On a phone it is square until that would take
         * more than about three fifths of the screen — a phone held sideways,
         * or a short one — so the title and price are never pushed a whole
         * screen down.
         */
        data-product-photo
        className={`surface-studio relative aspect-square max-h-[62svh] w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)] lg:max-h-none ${BLEED}`}
        onMouseMove={active.kind === "image" ? trackCursor : undefined}
        onMouseEnter={
          active.kind === "image"
            ? () => {
                if (window.matchMedia("(hover: hover)").matches) setZooming(true);
              }
            : undefined
        }
        onMouseLeave={() => setZooming(false)}
      >
        <div
          ref={trackRef}
          onScroll={onTrackScroll}
          aria-roledescription="carousel"
          aria-label={`${title} photographs`}
          className="flex size-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] lg:snap-none lg:overflow-hidden [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item, position) => {
            const current = position === safeIndex;
            return (
              <div
                key={item.id}
                aria-roledescription="slide"
                aria-label={`${position + 1} of ${count}`}
                aria-hidden={current ? undefined : true}
                className="relative size-full shrink-0 snap-center snap-always"
              >
                {item.kind === "video" ? (
                  <VideoFrame url={item.url} title={item.altText} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    onPointerEnter={preloadViewer}
                    onFocus={preloadViewer}
                    tabIndex={current ? 0 : -1}
                    aria-label={`Open ${item.altText} full screen`}
                    className="relative block size-full cursor-zoom-in"
                  >
                    {/* The transform is the zoom: the origin follows the
                        cursor, and the element's own box never changes. On a
                        desktop the shot fades in as it is chosen; on a phone
                        the slide itself is the movement. */}
                    <MediaImage
                      key={desktop && current ? `${item.id}-shown` : item.id}
                      src={item.url}
                      alt={item.altText}
                      /* Full width on a phone, half the page beside the buy box
                         from `lg`, and never wider than the column itself. */
                      sizes="(min-width: 1024px) 48vw, 100vw"
                      /* The first shot is what a shopper waits for, so it is
                         not lazy and is given priority over the rest. */
                      priority={position === 0}
                      fetchPriority={position === 0 ? "high" : "auto"}
                      className={`object-cover transition-transform duration-300 ease-out motion-reduce:transition-none max-lg:object-contain ${
                        desktop && current ? "animate-fade-in" : ""
                      }`}
                      style={{
                        transform: zooming && current ? "scale(2)" : "scale(1)",
                        transformOrigin: `${origin.x}% ${origin.y}%`,
                      }}
                    />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {count > 1 ? (
          <>
            <p className="pointer-events-none absolute bottom-3 right-3 hidden rounded-control bg-ink/70 px-2 py-1 text-meta text-paper lg:block">
              {safeIndex + 1} / {count}
            </p>

            {/*
             * Where you are, on a phone: a row of short dashes along the foot
             * of the photograph, the current one longer and darker. Each is a
             * real button with a 24px-tall target around a 3px mark, so it can
             * be tapped as well as read — but the swipe is how most people move.
             */}
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center lg:hidden">
              <ul className="pointer-events-auto flex items-center">
                {items.map((item, position) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setIndex(position)}
                      aria-label={
                        item.kind === "video"
                          ? "Show the product video"
                          : `Show ${item.altText}`
                      }
                      aria-current={position === safeIndex ? "true" : undefined}
                      className="flex h-6 w-7 items-center justify-center"
                    >
                      <span
                        aria-hidden="true"
                        className={`block h-[3px] rounded-full transition-[width,background-color] duration-300 ease-[var(--ease-out-quint)] ${
                          position === safeIndex ? "w-6 bg-ink" : "w-4 bg-ink/20"
                        }`}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}

        {overlay}
      </div>

      {count > 1 ? (
        <ul className="hidden flex-wrap gap-3 lg:flex">
          {items.map((item, position) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                aria-label={
                  item.kind === "video"
                    ? "Show the product video"
                    : `Show ${item.altText}`
                }
                aria-current={position === safeIndex ? "true" : undefined}
                className={`relative block overflow-hidden rounded-card border transition-[border-color,opacity,box-shadow] duration-150 ${
                  position === safeIndex
                    ? "border-blue-600 opacity-100 shadow-[var(--shadow-raise)]"
                    : "border-blue-300 opacity-70 hover:border-blue-500 hover:opacity-100"
                }`}
              >
                {item.kind === "video" ? (
                  <span className="flex size-20 items-center justify-center bg-ink text-paper">
                    <IconPlay size={22} />
                  </span>
                ) : (
                  <MediaImage
                    src={item.url}
                    alt=""
                    width={80}
                    height={80}
                    sizes="80px"
                    className="size-20 object-cover"
                  />
                )}
                {/* The active thumbnail is marked by more than colour: a bar
                    under it, for anyone who cannot tell the borders apart. */}
                {position === safeIndex ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-1 bg-blue-600"
                  />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <GalleryViewer
          title={title}
          items={items}
          index={safeIndex}
          step={step}
          setIndex={setIndex}
          onClose={closeViewer}
        />
      ) : null}
    </div>
  );
}
