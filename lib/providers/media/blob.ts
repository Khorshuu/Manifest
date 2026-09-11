import { randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";
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
export class BlobMediaProvider implements MediaProvider {
  readonly name = "blob";

  private readonly token: string | undefined;
  private readonly prefix: string;

  constructor(token = process.env.BLOB_READ_WRITE_TOKEN, prefix = "products") {
    this.token = token;
    this.prefix = prefix;
  }

  async upload(input: UploadInput): Promise<StoredMedia> {
    const contentType = validateUpload(input);
    const extension = extensionFor(contentType)!;

    // Generated, never taken from the browser: a supplied name can carry path
    // separators, traversal, or a second extension.
    const key = `${this.prefix}/${randomUUID()}.${extension}`;

    const stored = await put(key, input.data, {
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
      bytes: input.data.length,
    };
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
