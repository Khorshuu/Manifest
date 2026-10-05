"use client";

import { useEffect, useRef, useState } from "react";
import { IconClose, IconPlay } from "@/components/icons";
import { MediaImage } from "@/components/media-image";
import { VideoFrame, type MediaItem } from "./gallery";

/**
 * The full-screen photograph, with pinch and double-tap to zoom.
 *
 * A phone has no cursor for the hover magnifier, so the viewer is where a
 * shopper looks closely. Two fingers scale the picture between 1× and 4×, one
 * finger pans it once it is enlarged, and a double tap toggles 2×. While it is
 * enlarged the gestures stop here, so a pan never reads as a swipe to the next
 * photograph; at 1× they pass through and swiping works as before.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const lastTap = useRef(0);

  const distance = (touches: React.TouchList) =>
    Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      draggable={false}
      className="animate-fade-in max-h-full max-w-full touch-none select-none object-contain transition-transform duration-150 ease-out motion-reduce:transition-none"
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
      onDoubleClick={() => (scale > 1 ? reset() : setScale(2))}
      onTouchStart={(event) => {
        if (event.touches.length === 2) {
          pinch.current = { distance: distance(event.touches), scale };
          pan.current = null;
          event.stopPropagation();
          return;
        }
        const now = Date.now();
        if (now - lastTap.current < 280) {
          if (scale > 1) reset();
          else setScale(2);
          lastTap.current = 0;
          event.stopPropagation();
          return;
        }
        lastTap.current = now;
        if (scale > 1) {
          const touch = event.touches[0];
          pan.current = { x: touch.clientX, y: touch.clientY, ox: offset.x, oy: offset.y };
          event.stopPropagation();
        }
      }}
      onTouchMove={(event) => {
        if (pinch.current && event.touches.length === 2) {
          const next = (pinch.current.scale * distance(event.touches)) / pinch.current.distance;
          setScale(Math.min(4, Math.max(1, next)));
          event.stopPropagation();
        } else if (pan.current && event.touches.length === 1) {
          const touch = event.touches[0];
          setOffset({
            x: pan.current.ox + touch.clientX - pan.current.x,
            y: pan.current.oy + touch.clientY - pan.current.y,
          });
          event.stopPropagation();
        }
      }}
      onTouchEnd={(event) => {
        const gesturing = pinch.current !== null || pan.current !== null || scale > 1;
        if (event.touches.length < 2) pinch.current = null;
        if (event.touches.length === 0) pan.current = null;
        if (scale <= 1.02) reset();
        if (gesturing) event.stopPropagation();
      }}
    />
  );
}

/**
 * The full-screen viewer over the product gallery (gallery.tsx), loaded the
 * first time a shopper reaches for a photograph rather than with the page.
 */
export default function GalleryViewer({
  title,
  items,
  index: safeIndex,
  step,
  setIndex,
  onClose,
}: {
  title: string;
  items: MediaItem[];
  /** Which item is showing; always within `items`. */
  index: number;
  step: (delta: number) => void;
  setIndex: (position: number) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStart = useRef<number | null>(null);
  const count = items.length;
  const active = items[safeIndex];

  // Keyboard control for the viewer. Bound only while it is open, so the
  // arrow keys keep scrolling the page the rest of the time.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
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
  }, [onClose, step]);

  function onViewerTouchEnd(event: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (start === null) return;

    const delta = event.changedTouches[0].clientX - start;
    // 40px, so a scroll that drifts sideways is not read as a swipe.
    if (Math.abs(delta) > 40) step(delta < 0 ? 1 : -1);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — photographs`}
      className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-ink-deep/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur"
      onClick={(event) => {
        // Only the ground closes it; a click on the picture does not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex items-center justify-between">
        {count > 1 ? (
          <p className="text-meta tabular-nums text-paper/80">
            {safeIndex + 1} / {count}
          </p>
        ) : (
          <span />
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={() => onClose()}
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
        onTouchEnd={onViewerTouchEnd}
      >
        {/* Arrows for a mouse on a desktop only; a phone swipes. */}
        {count > 1 ? (
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous image"
            className="hidden size-11 shrink-0 items-center justify-center rounded-control bg-paper/10 text-paper hover:bg-paper/20 lg:inline-flex"
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : null}

        {active.kind === "video" ? (
          <div className="aspect-video max-h-full w-full max-w-4xl">
            <VideoFrame url={active.url} title={active.altText} />
          </div>
        ) : (
          /* Keyed so moving to another photograph starts it at 1×. */
          <ZoomableImage key={active.id} src={active.url} alt={active.altText} />
        )}

        {count > 1 ? (
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next image"
            className="hidden size-11 shrink-0 items-center justify-center rounded-control bg-paper/10 text-paper hover:bg-paper/20 lg:inline-flex"
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </div>

      {count > 1 ? (
        <>
          <ul className="mt-4 hidden flex-wrap justify-center gap-2 lg:flex">
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
                  className={`block overflow-hidden rounded-control border ${
                    position === safeIndex
                      ? "border-paper"
                      : "border-transparent opacity-60 hover:opacity-100"
                  }`}
                >
                  {item.kind === "video" ? (
                    <span className="flex size-14 items-center justify-center bg-paper/10 text-paper">
                      <IconPlay size={18} />
                    </span>
                  ) : (
                    <MediaImage
                      src={item.url}
                      alt=""
                      width={56}
                      height={56}
                      className="size-14 object-cover"
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>
          <p aria-hidden="true" className="mt-4 flex justify-center gap-1.5 lg:hidden">
            {items.map((item, position) => (
              <span
                key={item.id}
                className={`block h-1.5 rounded-full transition-[width,background-color] duration-300 ${
                  position === safeIndex ? "w-4 bg-paper" : "w-1.5 bg-paper/35"
                }`}
              />
            ))}
          </p>
        </>
      ) : null}
    </div>
  );
}
