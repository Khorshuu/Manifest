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

/**
 * Writes uploads to the public directory.
 *
 * This is the development implementation, and it is a real one: an admin can
 * upload a photograph and see it on the storefront. It is not suitable for a
 * serverless deployment, which has no persistent disk — that is what the R2
 * implementation is for (DECISIONS.md D-001).
 */
export class LocalMediaProvider implements MediaProvider {
  readonly name = "local";

  private readonly directory: string;
  private readonly publicPath: string;

  constructor(
    directory = join(process.cwd(), "public", "uploads"),
    publicPath = "/uploads",
  ) {
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
    await writeFile(join(this.directory, key), input.data);

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

    await unlink(join(this.directory, key)).catch(() => undefined);
  }
}
