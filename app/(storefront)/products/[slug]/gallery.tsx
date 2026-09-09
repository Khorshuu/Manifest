"use client";

import { useState } from "react";
import { ProductArt } from "@/components/product-art";

export type GalleryImage = { id: string; url: string; altText: string };

/**
 * The product photography, with the thumbnails actually doing something.
 *
 * Thumbnails are buttons, not decorations: they are reachable by keyboard and
 * announce which one is showing. The main image fades between shots rather
 * than snapping, which is the difference between a page that feels built and
 * one that feels assembled.
 */
export function Gallery({
  images,
  title,
  slug,
}: {
  images: GalleryImage[];
  title: string;
  slug: string;
}) {
  const [index, setIndex] = useState(0);

  if (images.length === 0) {
    return (
      <div className="surface-studio aspect-square w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)]">
        {/* Generated artwork rather than an empty box: a young catalogue
            should still look deliberate. */}
        <ProductArt title={title} seed={slug} className="size-full" />
      </div>
    );
  }

  const active = images[Math.min(index, images.length - 1)];

  return (
    <div className="flex flex-col gap-4">
      <div className="media-zoom surface-studio aspect-square w-full overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)]">
        {/* Keyed so a change re-runs the fade rather than swapping silently. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={active.id}
          src={active.url}
          alt={active.altText}
          className="animate-fade-in size-full object-cover"
        />
      </div>

      {images.length > 1 ? (
        <ul className="flex flex-wrap gap-3">
          {images.map((image, position) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                aria-label={`Show ${image.altText}`}
                aria-current={position === index ? "true" : undefined}
                className={`block overflow-hidden rounded-card border transition-[border-color,opacity,box-shadow] duration-150 ${
                  position === index
                    ? "border-blue-600 opacity-100 shadow-[var(--shadow-raise)]"
                    : "border-blue-300 opacity-70 hover:border-blue-500 hover:opacity-100"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt=""
                  className="size-20 object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
