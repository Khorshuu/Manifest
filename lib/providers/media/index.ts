import { BlobMediaProvider } from "./blob";
import { LocalMediaProvider } from "./local";
import type { MediaProvider } from "./types";

export * from "./types";
export { BlobMediaProvider, LocalMediaProvider };

let instance: MediaProvider | undefined;

/**
 * The media provider.
 *
 * MEDIA_PROVIDER picks it; with nothing set, a deployment that has a Blob
 * store uses it and everything else writes to disk. That default matters
 * because the local provider silently cannot work on a serverless host, and an
 * upload failing at the moment a photograph is added is a poor way to find
 * that out.
 */
export function getMediaProvider(): MediaProvider {
  instance ??= createProvider();
  return instance;
}

function createProvider(): MediaProvider {
  const configured = process.env.MEDIA_PROVIDER?.trim();

  if (configured === "blob") return new BlobMediaProvider();
  if (configured === "local") return new LocalMediaProvider();
  if (configured) {
    throw new Error(`MEDIA_PROVIDER must be 'local' or 'blob', not '${configured}'.`);
  }

  return process.env.BLOB_READ_WRITE_TOKEN?.trim()
    ? new BlobMediaProvider()
    : new LocalMediaProvider();
}

/** Test helper: replace the provider for the duration of a test. */
export function setMediaProviderForTesting(
  provider: MediaProvider | undefined,
): void {
  instance = provider;
}
