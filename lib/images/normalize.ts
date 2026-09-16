import { createHash } from "node:crypto";
import sharp from "sharp";
import { UploadRejectedError } from "@/lib/providers/media/types";

/**
 * The server half of the image pipeline (DECISIONS.md D-055).
 *
 * The crop editor already frames and compresses a photograph in the browser
 * (D-049), but a browser is not a place to enforce anything: a request can
 * skip the editor entirely. So every stored image is decoded and written
 * afresh here, whatever arrived:
 *
 * - decoding is capped by pixel count, so a small file that expands to an
 *   enormous bitmap (a "decompression bomb") is refused before it can exhaust
 *   memory;
 * - the orientation recorded in EXIF is applied to the pixels, so nothing
 *   depends on a viewer honouring it once the metadata is gone;
 * - colour is converted to sRGB, which is what every browser assumes, so a
 *   wide-gamut or CMYK photograph does not come out dull or inverted;
 * - all metadata is dropped — EXIF with camera serials and GPS positions, XMP,
 *   embedded profiles and comments — because re-encoding only copies what is
 *   asked for, and nothing is;
 * - the result is one WebP no larger than the site ever displays.
 *
 * Re-encoding also means the stored bytes are ones this code wrote: anything
 * smuggled after an image's end marker or inside a metadata chunk does not
 * survive.
 *
 * Smaller sizes for phones are not made here. Every storefront photograph goes
 * through `next/image` (components/media-image.tsx), which cuts the widths a
 * device asks for from this master and caches them at the edge.
 */

/** 40 megapixels: a full-frame camera original, and far above what the editor sends. */
export const MAX_INPUT_PIXELS = 40_000_000;

/** The long edge of a stored image. The editor saves 2000; this leaves headroom. */
export const MAX_STORED_EDGE = 2400;

const WEBP_QUALITY = 85;

const TOO_MANY_PIXELS = "That image has too many pixels. Export it at a smaller size.";

export type NormalizedImage = {
  data: Buffer;
  contentType: "image/webp";
  width: number;
  height: number;
  /** Hex SHA-256 of the stored bytes. */
  sha256: string;
};

export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  let pipeline: ReturnType<typeof sharp>;
  try {
    pipeline = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      // A truncated or corrupt file is refused rather than half-decoded.
      failOn: "error",
      // Only the first frame of an animation: a product photograph is still.
      pages: 1,
    });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new UploadRejectedError("That image could not be read.");
    }
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw new UploadRejectedError(TOO_MANY_PIXELS);
    }
  } catch (error) {
    if (error instanceof UploadRejectedError) throw error;
    // sharp checks the header against limitInputPixels itself.
    if (String(error).includes("pixel limit")) throw new UploadRejectedError(TOO_MANY_PIXELS);
    throw new UploadRejectedError("That image could not be read.");
  }

  try {
    const { data, info } = await pipeline
      .rotate()
      .resize({
        width: MAX_STORED_EDGE,
        height: MAX_STORED_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      contentType: "image/webp",
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch {
    throw new UploadRejectedError("That image could not be read.");
  }
}
