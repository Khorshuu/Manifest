/**
 * Media storage interface.
 *
 * DECISIONS.md D-001 names Cloudflare R2 as the destination. Until those
 * credentials exist the local implementation writes to disk, and every call
 * site talks to this so swapping in R2 changes nothing but the implementation.
 */

export type StoredMedia = {
  /** The path the site serves the file from. */
  url: string;
  /** The provider's own identifier, for deleting it later. */
  key: string;
  contentType: string;
  bytes: number;
};

export type UploadInput = {
  data: Buffer;
  /** The name the browser sent. Never trusted, only used as a hint. */
  originalName: string;
  contentType: string;
};

export interface MediaProvider {
  readonly name: string;
  upload(input: UploadInput): Promise<StoredMedia>;
  delete(key: string): Promise<void>;
}

/**
 * What may be uploaded.
 *
 * Anything that can execute is absent by construction rather than blocked by a
 * denylist, which is always incomplete (docs/SECURITY.md).
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const EXTENSIONS: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export function extensionFor(contentType: string): string | null {
  return EXTENSIONS[contentType as ImageType] ?? null;
}

/**
 * Identifies the format from the file's own bytes.
 *
 * A browser-supplied content type is a claim, not evidence: an executable
 * renamed to .jpg arrives labelled image/jpeg. Sniffing the magic number is
 * what actually establishes what the file is.
 */
export function sniffImageType(data: Buffer): ImageType | null {
  if (data.length < 12) return null;

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => data[index] === byte)) return "image/png";

  // RIFF....WEBP
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  // ISO base media file with an AVIF brand.
  if (data.toString("ascii", 4, 8) === "ftyp") {
    const brand = data.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }

  return null;
}

export class UploadRejectedError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

/**
 * Validates an upload before it is stored. Returns the type established from
 * the bytes, which is what the file is actually saved as.
 */
export function validateUpload(input: UploadInput): ImageType {
  if (input.data.length === 0) {
    throw new UploadRejectedError("That file is empty.");
  }

  if (input.data.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError(
      `Images must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`,
    );
  }

  const sniffed = sniffImageType(input.data);

  if (!sniffed) {
    throw new UploadRejectedError(
      "That file is not a JPEG, PNG, WebP, or AVIF image.",
    );
  }

  // The declared type is checked against the bytes, so a mismatch is refused
  // rather than quietly trusted either way.
  if (
    input.contentType &&
    input.contentType !== sniffed &&
    ALLOWED_IMAGE_TYPES.includes(input.contentType as ImageType)
  ) {
    throw new UploadRejectedError(
      "That file's contents do not match the type it claims to be.",
    );
  }

  return sniffed;
}

/**
 * The content type an uploaded file's extension implies.
 *
 * Only ever applied to a key this system generated, so the extension is one of
 * the four above by construction — but it returns null rather than guessing if
 * it is ever handed something else.
 */
export function contentTypeForExtension(extension: string): ImageType | null {
  const match = (Object.entries(EXTENSIONS) as [ImageType, string][]).find(
    ([, value]) => value === extension.toLowerCase(),
  );
  return match ? match[0] : null;
}
