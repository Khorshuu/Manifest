/**
 * The browser half of cropping (D-049): decoding, turning, drawing and
 * compressing. The arithmetic lives in ./crop.ts; everything here needs a
 * canvas and so runs only in the admin's browser.
 *
 * Cropping happens before upload, so the existing upload route receives an
 * ordinary, already-small WebP or JPEG and keeps doing every check it did.
 */
import {
  averageEdgeColour,
  drawRect,
  MAX_DECODE_EDGE,
  outputSize,
  type Placement,
  type Size,
} from "./crop";

/** Anything drawable with a known size: a decoded file or a turned copy. */
export type CropSource = ImageBitmap | HTMLCanvasElement;

/**
 * Decodes a file the right way up.
 *
 * `imageOrientation: "from-image"` applies the EXIF orientation a phone camera
 * writes, so a portrait shot is not handed to the editor lying on its side.
 * A very large original is reduced to MAX_DECODE_EDGE on its long side first,
 * which is still far more than any saved image needs.
 */
export async function decodeImage(blob: Blob): Promise<CropSource> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge <= MAX_DECODE_EDGE) return bitmap;

  const factor = MAX_DECODE_EDGE / longEdge;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * factor);
  canvas.height = Math.round(bitmap.height * factor);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw images.");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** Frees a decoded image's memory once the editor has finished with it. */
export function releaseSource(source: CropSource | null | undefined) {
  if (source && "close" in source) source.close();
}

/** A copy turned by quarter turns clockwise. */
export function turnSource(source: CropSource, quarterTurns: number): CropSource {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (turns === 0) return source;

  const sideways = turns % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? source.height : source.width;
  canvas.height = sideways ? source.width : source.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw images.");

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((turns * Math.PI) / 2);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/** The colour around the picture's edge, read from a small copy of it. */
export function edgeColourOf(source: CropSource): string {
  const canvas = document.createElement("canvas");
  const longEdge = Math.max(source.width, source.height);
  const factor = Math.min(1, 64 / longEdge);
  canvas.width = Math.max(1, Math.round(source.width * factor));
  canvas.height = Math.max(1, Math.round(source.height * factor));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "#ffffff";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return averageEdgeColour(data, canvas.width, canvas.height);
}

/** Draws the crop into a canvas `width` wide — the saved file, or a preview. */
export function renderCrop(
  canvas: HTMLCanvasElement,
  source: CropSource,
  frame: Size,
  placement: Placement,
  width: number,
  fill: string,
) {
  const height = Math.max(1, Math.round((frame.height / frame.width) * width));
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw images.");

  context.fillStyle = fill;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const rect = drawRect(source, frame, placement, canvas.width);
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
}

/** Just under the upload route's 5MB ceiling. */
const MAX_OUTPUT_BYTES = 4.8 * 1024 * 1024;

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
}

/**
 * The saved file: WebP where the browser can write it, JPEG otherwise, at a
 * quality that keeps product detail. Quality steps down only if a file would
 * not fit under the upload limit.
 */
export async function encodeCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of [0.9, 0.82, 0.72, 0.6]) {
    let blob = await toBlob(canvas, "image/webp", quality);
    // A browser that cannot write WebP quietly hands back a PNG instead.
    if (!blob || blob.type !== "image/webp") {
      blob = await toBlob(canvas, "image/jpeg", quality);
    }
    if (blob && blob.size <= MAX_OUTPUT_BYTES) return blob;
  }
  throw new Error("That image could not be made small enough to upload.");
}

/** The final file for a crop, and its size. */
export async function exportCrop(
  source: CropSource,
  frame: Size,
  placement: Placement,
  fill: string,
): Promise<{ blob: Blob; width: number; height: number }> {
  const size = outputSize(frame, placement);
  const canvas = document.createElement("canvas");
  // The output is the frame, shrunk only so the original is never enlarged;
  // the placement is scaled with it inside renderCrop.
  renderCrop(canvas, source, frame, placement, size.width, fill);
  const blob = await encodeCanvas(canvas);
  return { blob, width: canvas.width, height: canvas.height };
}
