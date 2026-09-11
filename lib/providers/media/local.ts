import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extensionFor,
  validateUpload,
  type MediaProvider,
  type StoredMedia,
  type UploadInput,
} from "./types";

/** Outside `public/`, and served by app/uploads/[key]/route.ts. */
export const LOCAL_UPLOAD_DIR = join(process.cwd(), ".uploads");

/**
 * Writes uploads to a directory on disk.
 *
 * This is the development implementation, and it is a real one: an admin can
 * upload a photograph and see it on the storefront. It is not suitable for a
 * serverless deployment, which has no persistent disk — that is what the R2
 * implementation is for (DECISIONS.md D-001).
 *
 * The files deliberately do *not* live in `public/`. Next.js resolves that
 * directory when the application is built, so a file written into it
 * afterwards is never served by `next start` — an upload worked in development
 * and returned 404 in production, which only showed up once the end-to-end
 * suite was run against a production build. They are served by a route handler
 * instead, which reads from disk per request. That is also closer in shape to
 * the R2 implementation, where the bytes never sit next to the application at
 * all.
 */
export class LocalMediaProvider implements MediaProvider {
  readonly name = "local";

  private readonly directory: string;
  private readonly publicPath: string;

  constructor(directory = LOCAL_UPLOAD_DIR, publicPath = "/uploads") {
    this.directory = directory;
    this.publicPath = publicPath;
  }

  async upload(input: UploadInput): Promise<StoredMedia> {
    const contentType = validateUpload(input);
    const extension = extensionFor(contentType)!;

    // The filename is generated, never taken from the browser: a supplied name
    // can carry path separators, traversal, or a second extension.
    const key = `${randomUUID()}.${extension}`;

    await mkdir(this.directory, { recursive: true });
    // turbopackIgnore: the directory is configuration, not a traced import.
    await writeFile(join(/*turbopackIgnore: true*/ this.directory, key), input.data);

    return {
      url: `${this.publicPath}/${key}`,
      key,
      contentType,
      bytes: input.data.length,
    };
  }

  async delete(key: string): Promise<void> {
    // Only a bare generated filename is ever accepted, so a key containing a
    // separator is a bug or an attack, not a path to follow.
    if (key.includes("/") || key.includes("\\") || key.includes("..")) {
      throw new Error("That media key is not valid.");
    }

    await unlink(join(/*turbopackIgnore: true*/ this.directory, key)).catch(() => undefined);
  }
}
