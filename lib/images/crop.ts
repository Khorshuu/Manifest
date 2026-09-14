/**
 * The geometry of cropping a product photograph (D-049).
 *
 * Pure arithmetic with no browser in it, so every rule the crop editor relies
 * on — what a ratio is called, how an upload is first framed, how far it may
 * be dragged, how large the saved file is — is tested on its own
 * (tests/image-crop.test.ts). The editor draws; this decides.
 *
 * Coordinates are "frame pixels": the frame is the saved image at its target
 * size (1600 × 2000 for the 4:5 standard), and a placement says how large the
 * source is drawn in it (`scale`, frame pixels per source pixel) and where its
 * centre sits relative to the frame's centre (`x`, `y`). The picture is only
 * ever scaled uniformly, so nothing is ever stretched.
 */

export type Size = { width: number; height: number };

export type AspectRatio = { width: number; height: number };

export type RatioPreset = {
  id: string;
  width: number;
  height: number;
  /** A word under the ratio on its button. */
  note: string;
};

export const RATIO_PRESETS: readonly RatioPreset[] = [
  { id: "4:5", width: 4, height: 5, note: "Product" },
  { id: "1:1", width: 1, height: 1, note: "Square" },
  { id: "3:4", width: 3, height: 4, note: "Portrait" },
  { id: "2:3", width: 2, height: 3, note: "Portrait" },
  { id: "16:9", width: 16, height: 9, note: "Landscape" },
  { id: "4:3", width: 4, height: 3, note: "Landscape" },
  { id: "3:2", width: 3, height: 2, note: "Landscape" },
];

/** Manifest's standard product photograph. */
export const DEFAULT_RATIO_ID = "4:5";

/** The long edge of a saved image: 4:5 comes out at 1600 × 2000. */
export const TARGET_LONG_EDGE = 2000;

/** Anything more extreme than this is a banner, not a product photograph. */
export const MAX_RATIO = 10;

/** What the editor opens. The server still decides what may be stored. */
export const CROP_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

/** The original may be large — it is cropped and compressed before upload. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/** Originals are decoded no larger than this, so a 50MP photo cannot freeze the page. */
export const MAX_DECODE_EDGE = 6000;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The ratio a width and height reduce to, as a person would write it.
 *
 * 1200 × 1500 is "4:5" and 1.5 × 1 is "3:2". A pair that does not reduce to
 * small numbers takes the name of the preset it is within 1% of, and failing
 * that is written as a decimal against 1 ("1.91:1").
 */
export function ratioLabel(width: number, height: number): string {
  const a = Math.round(width * 100);
  const b = Math.round(height * 100);
  const divisor = gcd(a, b);
  const x = a / divisor;
  const y = b / divisor;
  if (x <= 50 && y <= 50) return `${x}:${y}`;

  const value = width / height;
  const preset = RATIO_PRESETS.find(
    (entry) => Math.abs(entry.width / entry.height - value) / value < 0.01,
  );
  if (preset) return preset.id;

  return value >= 1
    ? `${Number(value.toFixed(2))}:1`
    : `1:${Number((1 / value).toFixed(2))}`;
}

export type CustomRatioResult =
  | { ok: true; ratio: AspectRatio; label: string }
  | { ok: false; error: string };

/** Reads the Custom fields, refusing anything that is not a real shape. */
export function parseCustomRatio(
  widthText: string,
  heightText: string,
): CustomRatioResult {
  if (widthText.trim() === "" || heightText.trim() === "") {
    return { ok: false, error: "Enter a width and a height." };
  }

  const width = Number(widthText.trim());
  const height = Number(heightText.trim());

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, error: "Width and height must be numbers." };
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, error: "Width and height must be more than zero." };
  }
  if (width > 100_000 || height > 100_000) {
    return { ok: false, error: "Those numbers are too large." };
  }
  if (width / height > MAX_RATIO || height / width > MAX_RATIO) {
    return {
      ok: false,
      error: `That shape is too extreme. Keep it within ${MAX_RATIO}:1.`,
    };
  }

  return { ok: true, ratio: { width, height }, label: ratioLabel(width, height) };
}

/** The saved image's size for a ratio, at the target long edge. */
export function frameSize(
  ratio: AspectRatio,
  longEdge: number = TARGET_LONG_EDGE,
): Size {
  const value = ratio.width / ratio.height;
  return value >= 1
    ? { width: longEdge, height: Math.round(longEdge / value) }
    : { width: Math.round(longEdge * value), height: longEdge };
}

export type Placement = { scale: number; x: number; y: number };

/** The scale at which the source just covers the frame. */
export function coverScale(source: Size, frame: Size): number {
  return Math.max(frame.width / source.width, frame.height / source.height);
}

/** The scale at which the whole source just fits inside the frame. */
export function containScale(source: Size, frame: Size): number {
  return Math.min(frame.width / source.width, frame.height / source.height);
}

/**
 * How far zoom may go: out to half of "whole image showing", so an admin can
 * leave space around a product, and in to six times "frame filled".
 */
export function zoomLimits(source: Size, frame: Size) {
  return {
    min: containScale(source, frame) * 0.5,
    max: coverScale(source, frame) * 6,
  };
}

/**
 * How an upload is first framed.
 *
 * Product-safe by default: when the photograph is close to the frame's shape
 * it fills the frame, trimming at most a sliver; otherwise the whole of it is
 * shown and the admin chooses how much to cut. Nothing is zoomed in on, so
 * nothing of the product is lost before anyone has looked.
 */
export function initialPlacement(source: Size, frame: Size): Placement {
  const relative =
    source.width / source.height / (frame.width / frame.height);
  const scale =
    relative >= 0.88 && relative <= 1.14
      ? coverScale(source, frame)
      : containScale(source, frame);
  return { scale, x: 0, y: 0 };
}

/**
 * Keeps a placement sensible.
 *
 * A source larger than the frame in a direction may move only until its edge
 * meets the frame's, so no gap opens; a source smaller than the frame may move
 * only until its edge meets the frame's from inside, so none of it is lost.
 */
export function clampPlacement(
  placement: Placement,
  source: Size,
  frame: Size,
): Placement {
  const { min, max } = zoomLimits(source, frame);
  const scale = clamp(placement.scale, min, max);
  const limitX = Math.abs(source.width * scale - frame.width) / 2;
  const limitY = Math.abs(source.height * scale - frame.height) / 2;
  return {
    scale,
    x: clamp(placement.x, -limitX, limitX),
    y: clamp(placement.y, -limitY, limitY),
  };
}

/**
 * Zooms keeping one point still — under the cursor, between two fingers, or
 * the frame's centre (0, 0) for the slider.
 */
export function zoomAround(
  placement: Placement,
  nextScale: number,
  point: { x: number; y: number },
  source: Size,
  frame: Size,
): Placement {
  const { min, max } = zoomLimits(source, frame);
  const scale = clamp(nextScale, min, max);
  const factor = scale / placement.scale;
  return clampPlacement(
    {
      scale,
      x: point.x + (placement.x - point.x) * factor,
      y: point.y + (placement.y - point.y) * factor,
    },
    source,
    frame,
  );
}

/**
 * Where the source is drawn inside an output `outWidth` wide, of the frame's
 * shape. The same arithmetic serves the saved file, the preview and the
 * editor's own canvas, so what is shown is what is saved.
 */
export function drawRect(
  source: Size,
  frame: Size,
  placement: Placement,
  outWidth: number,
) {
  const k = outWidth / frame.width;
  const width = source.width * placement.scale * k;
  const height = source.height * placement.scale * k;
  const centreX = outWidth / 2 + placement.x * k;
  const centreY = (frame.height * k) / 2 + placement.y * k;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

/**
 * The saved image's size.
 *
 * The target size, unless reaching it would mean enlarging the original: a
 * small photograph is saved at the resolution it actually has rather than
 * blown up into a large, soft file.
 */
export function outputSize(frame: Size, placement: Placement): Size {
  const factor = Math.min(1, 1 / placement.scale);
  return {
    width: Math.max(1, Math.round(frame.width * factor)),
    height: Math.max(1, Math.round(frame.height * factor)),
  };
}

/**
 * The colour around the edge of a picture, from its pixels.
 *
 * Space left beside a product (a narrow photograph in a wide frame) is filled
 * with this, so a white studio shot stays white and a grey one stays grey
 * rather than being boxed in a colour of our choosing. A mostly transparent
 * edge reads as white.
 */
export function averageEdgeColour(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  let count = 0;

  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    const a = data[offset + 3] / 255;
    red += data[offset] * a;
    green += data[offset + 1] * a;
    blue += data[offset + 2] * a;
    alpha += a;
    count += 1;
  };

  for (let x = 0; x < width; x++) {
    add(x, 0);
    if (height > 1) add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    add(0, y);
    if (width > 1) add(width - 1, y);
  }

  if (count === 0 || alpha / count < 0.5) return "#ffffff";

  const hex = (value: number) =>
    Math.round(value / alpha)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
