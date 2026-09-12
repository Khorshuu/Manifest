import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * One photograph in the catalogue, at the size the screen actually needs.
 *
 * Product photography is the heaviest thing this shop sends, and it was going
 * out at its stored size to every device: a 2000px press shot arriving on a
 * 390px phone to be drawn 180px wide, and again at 80px in every thumbnail.
 * `next/image` rewrites that into a `srcset` and lets the browser pick, which
 * is the single largest saving available on a phone connection.
 *
 * The seeded catalogue is SVG, and the optimiser refuses SVG by design — an
 * SVG can carry script, so running one through the resizer would mean turning
 * on `dangerouslyAllowSVG` for the whole site. A vector is already
 * resolution-independent and a few kilobytes, so there is nothing to gain:
 * those keep the plain element they always had.
 *
 * Two shapes. By default the photograph fills a box that already has a size —
 * an `aspect-*` container, which must be positioned — and `sizes` says how
 * wide that box really is at each width, or the browser fetches the largest
 * candidate every time. Given `width` and `height` it is laid out at that size
 * instead, for the thumbnails, where the box is the picture.
 */
export function MediaImage({
  src,
  alt,
  sizes,
  width,
  height,
  className = "",
  priority = false,
  fetchPriority,
  objectPosition,
  style,
}: {
  src: string;
  alt: string;
  /** How wide the box is at each width — e.g. "(min-width: 640px) 33vw, 50vw". */
  sizes?: string;
  /** Both together lay the picture out at a fixed size rather than filling. */
  width?: number;
  height?: number;
  className?: string;
  /** Only for a photograph above the fold; never more than one per page. */
  priority?: boolean;
  fetchPriority?: "high" | "low" | "auto";
  objectPosition?: string;
  style?: CSSProperties;
}) {
  const fixed = width !== undefined && height !== undefined;
  const merged: CSSProperties | undefined =
    objectPosition || style ? { ...style, ...(objectPosition ? { objectPosition } : null) } : undefined;

  if (/\.svgz?($|\?)/i.test(src)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={fetchPriority}
        decoding="async"
        className={fixed ? className : `absolute inset-0 size-full ${className}`}
        style={merged}
      />
    );
  }

  if (fixed) {
    return (
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        priority={priority}
        fetchPriority={fetchPriority}
        className={className}
        style={merged}
      />
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      fetchPriority={fetchPriority}
      className={className}
      style={merged}
    />
  );
}
