import { LocalMediaProvider } from "./local";
import type { MediaProvider } from "./types";

export * from "./types";
export { LocalMediaProvider };

let instance: MediaProvider | undefined;

/**
 * The media provider. Only the local one exists; an R2 implementation slots in
 * here without any call site changing.
 */
export function getMediaProvider(): MediaProvider {
  instance ??= new LocalMediaProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setMediaProviderForTesting(
  provider: MediaProvider | undefined,
): void {
  instance = provider;
}
