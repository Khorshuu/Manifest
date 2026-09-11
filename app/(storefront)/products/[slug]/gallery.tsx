"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose, IconPlay } from "@/components/icons";
import { ProductArt } from "@/components/product-art";

export type GalleryImage = { id: string; url: string; altText: string };

/**
 * The product media, as a shopper actually uses it.
 *
 * Three behaviours, each earning its place:
 *
 *  - Thumbnails are buttons. They are reachable by keyboard and announce
 *    which one is showing, and the main image fades between shots rather than
 *    snapping.
 *  - Hovering the main image magnifies the part under the cursor. It is the
 *    same file scaled with a moving transform origin, so nothing reloads,
 *    nothing blurs beyond the source's own resolution, and the frame never
 *    changes size — a zoom that reflows the page is worse than no zoom.
 *  - Clicking opens a full-screen viewer with arrows, thumbnails, escape to
 *    close and swipe on a touch screen.
 *
 * Touch devices never see the hover zoom: there is no cursor to follow, so
 * the tap opens the viewer instead, which is the touch-friendly equivalent.
 */

type MediaItem =
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

function VideoFrame({ url, title }: { url: string; title: string }) {
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

export function Gallery({
  images,
  title,
  slug,
  videoUrl,
}: {
  images: GalleryImage[];
  title: string;
  slug: string;
  videoUrl?: string | null;
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStart = useRef<number | null>(null);

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

  // Keyboard control for the viewer. Bound only while it is open, so the
  // arrow keys keep scrolling the page the rest of the time.
  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowLeft") step(-1);
    }

    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under an overlay covering it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, step]);

  if (count === 0) {
    return (
      <div className="surface-studio aspect-square w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)]">
        {/* Generated artwork rather than an empty box: a young catalogue
            should still look deliberate. */}
        <ProductArt title={title} seed={slug} className="size-full" />
      </div>
    );
  }

  const active = items[Math.min(index, count - 1)];

  function trackCursor(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setOrigin({
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    });
  }

  function onTouchEnd(event: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (start === null) return;

    const delta = event.changedTouches[0].clientX - start;
    // 40px, so a scroll that drifts sideways is not read as a swipe.
    if (Math.abs(delta) > 40) step(delta < 0 ? 1 : -1);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        className="surface-studio relative aspect-square w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)]"
        onMouseMove={active.kind === "image" ? trackCursor : undefined}
        onMouseEnter={active.kind === "image" ? () => setZooming(true) : undefined}
        onMouseLeave={() => setZooming(false)}
        onTouchStart={(event) => {
          touchStart.current = event.touches[0].clientX;
        }}
        onTouchEnd={onTouchEnd}
      >
        {active.kind === "video" ? (
          <VideoFrame url={active.url} title={active.altText} />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Open ${active.altText} full screen`}
            className="block aspect-square size-full cursor-zoom-in"
          >
            {/* Keyed so a change re-runs the fade rather than swapping
                silently. The transform is the zoom: the origin follows the
                cursor, and the element's own box never changes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={active.id}
              src={active.url}
              alt={active.altText}
              /* The first shot is what a shopper waits for, so it is not
                 lazy and is given priority over the thumbnails. */
              fetchPriority={index === 0 ? "high" : "auto"}
              decoding="async"
              className="animate-fade-in size-full object-cover transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{
                transform: zooming ? "scale(2)" : "scale(1)",
                transformOrigin: `${origin.x}% ${origin.y}%`,
              }}
            />
          </button>
        )}

        {count > 1 ? (
          <p className="pointer-events-none absolute bottom-3 right-3 rounded-control bg-ink/70 px-2 py-1 text-meta text-paper">
            {index + 1} / {count}
          </p>
        ) : null}
      </div>

      {count > 1 ? (
        <ul className="flex flex-wrap gap-3">
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
                aria-current={position === index ? "true" : undefined}
                className={`relative block overflow-hidden rounded-card border transition-[border-color,opacity,box-shadow] duration-150 ${
                  position === index
                    ? "border-blue-600 opacity-100 shadow-[var(--shadow-raise)]"
                    : "border-blue-300 opacity-70 hover:border-blue-500 hover:opacity-100"
                }`}
              >
                {item.kind === "video" ? (
                  <span className="flex size-20 items-center justify-center bg-ink text-paper">
                    <IconPlay size={22} />
                  </span>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={item.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-20 object-cover"
                  />
                )}
                {/* The active thumbnail is marked by more than colour: a bar
                    under it, for anyone who cannot tell the borders apart. */}
                {position === index ? (
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${title} — photographs`}
          className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-ink-deep/95 p-4 backdrop-blur"
          onClick={(event) => {
            // Only the ground closes it; a click on the picture does not.
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="flex justify-end">
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center gap-2 rounded-control px-3 text-body text-paper hover:bg-paper/10"
            >
              <IconClose size={18} />
              Close
            </button>
          </div>

          <div
            className="flex min-h-0 flex-1 items-center justify-center gap-3"
            onTouchStart={(event) => {
              touchStart.current = event.touches[0].clientX;
            }}
            onTouchEnd={onTouchEnd}
          >
            {count > 1 ? (
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous image"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control bg-paper/10 text-paper hover:bg-paper/20"
              >
                <span aria-hidden="true">‹</span>
              </button>
            ) : null}

            {active.kind === "video" ? (
              <div className="aspect-video max-h-full w-full max-w-4xl">
                <VideoFrame url={active.url} title={active.altText} />
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={active.id}
                src={active.url}
                alt={active.altText}
                className="animate-fade-in max-h-full max-w-full object-contain"
              />
            )}

            {count > 1 ? (
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next image"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control bg-paper/10 text-paper hover:bg-paper/20"
              >
                <span aria-hidden="true">›</span>
              </button>
            ) : null}
          </div>

          {count > 1 ? (
            <ul className="mt-4 flex flex-wrap justify-center gap-2">
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
                    aria-current={position === index ? "true" : undefined}
                    className={`block overflow-hidden rounded-control border ${
                      position === index
                        ? "border-paper"
                        : "border-transparent opacity-60 hover:opacity-100"
                    }`}
                  >
                    {item.kind === "video" ? (
                      <span className="flex size-14 items-center justify-center bg-paper/10 text-paper">
                        <IconPlay size={18} />
                      </span>
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={item.url}
                        alt=""
                        loading="lazy"
                        className="size-14 object-cover"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
