import { randomUUID } from "node:crypto";
import { del, head, put } from "@vercel/blob";
import { normalizeImage } from "@/lib/images/normalize";
import {
  extensionFor,
  validateUpload,
  type MediaProvider,
  type StoredMedia,
  type UploadInput,
} from "./types";

/**
 * Stores uploads in Vercel Blob.
 *
 * A serverless deployment has no persistent disk, so the local provider's
 * files vanish between requests. This is the implementation DECISIONS.md D-001
 * anticipated; it names R2, and Blob is the same shape — bytes live in object
 * storage, the site only keeps the URL.
 *
 * The store is public, because a product photograph is public: the storefront
 * shows it to anyone. The name is still an unguessable identifier, so nothing
 * is discoverable by trying URLs.
 *
 * The returned URL is absolute and points at the blob host, not at this site,
 * so the Content-Security-Policy and the image loader both have to know that
 * host — see next.config.ts.
 */

/** A stored photograph is capped well below this; anything larger is a surprise. */
const MAX_READ_BYTES = 25 * 1024 * 1024;

export class BlobMediaProvider implements MediaProvider {
  readonly name = "blob";

  private readonly token: string | undefined;
  private readonly prefix: string;

  constructor(token = process.env.BLOB_READ_WRITE_TOKEN, prefix = "products") {
    this.token = token;
    this.prefix = prefix;
  }

  async upload(input: UploadInput): Promise<StoredMedia> {
    // Size and format first, from the bytes; then decoded and written afresh,
    // so what is stored is always a clean WebP (lib/images/normalize.ts).
    validateUpload(input);
    const image = await normalizeImage(input.data);
    const contentType = image.contentType;
    const extension = extensionFor(contentType)!;

    // Generated, never taken from the browser: a supplied name can carry path
    // separators, traversal, or a second extension.
    const key = `${this.prefix}/${randomUUID()}.${extension}`;

    const stored = await put(key, image.data, {
      access: "public",
      contentType,
      // The key is already unique, and a suffix would make it unpredictable
      // from the key the caller holds.
      addRandomSuffix: false,
      token: this.token,
    });

    return {
      url: stored.url,
      key: stored.pathname,
      contentType,
      bytes: image.data.length,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    };
  }

  /**
   * The pathname behind a blob address, or null. A blob URL is absolute and
   * lives on a `*.public.blob.vercel-storage.com` host, and only this store's
   * own prefix is claimed (risk R-11).
   */
  keyFor(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!parsed.hostname.endsWith(".blob.vercel-storage.com")) return null;
    const key = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
    if (!key || key.includes("..") || !key.startsWith(`${this.prefix}/`)) return null;
    return key;
  }

  /**
   * The stored bytes, so the reconciliation can measure a file it is recording
   * (risk R-11).
   *
   * The store is public, so this is an ordinary read of the blob's own URL —
   * no token, and nothing that is not already served to any shopper. It is
   * deliberately *not* `safeFetch`: that guards retrieval of an address
   * somebody supplied, and refuses the kind of host this one is. The host here
   * is this store's own, built from the key rather than taken from a caller,
   * and the size cap is what keeps a surprise from becoming a memory problem.
   */
  async read(key: string): Promise<Buffer | null> {
    if (!key || key.includes("..") || !key.startsWith(`${this.prefix}/`)) return null;

    const address = await head(key, { token: this.token }).catch(() => null);
    if (!address) return null;
    if (address.size > MAX_READ_BYTES) return null;

    const response = await fetch(address.url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!response?.ok) return null;

    const body = Buffer.from(await response.arrayBuffer());
    return body.length > MAX_READ_BYTES ? null : body;
  }

  async delete(key: string): Promise<void> {
    if (key.includes("..")) {
      throw new Error("That media key is not valid.");
    }

    // A missing blob is not an error worth failing a deletion over: the caller
    // wants the file gone, and it is.
    await del(key, { token: this.token }).catch(() => undefined);
  }
}
