import { getEnv } from "@/lib/env";
import { AnthropicExtractionProvider } from "./anthropic";
import type { ProductDocumentExtractionProvider } from "./types";
import { UnconfiguredExtractionProvider } from "./unconfigured";

export * from "./types";
export { AnthropicExtractionProvider, UnconfiguredExtractionProvider };

let instance: ProductDocumentExtractionProvider | undefined;

/**
 * The provider selected by PRODUCT_EXTRACTION_PROVIDER (D-123).
 *
 * `none` is the default and fully supported: every document is read by the
 * deterministic extractors and nothing else. `anthropic` adds source-grounded
 * reading of prose for documents those extractors could not use; it needs
 * ANTHROPIC_API_KEY, and without it reports UNAVAILABLE rather than failing
 * the research run.
 */
export function getProductExtractionProvider(): ProductDocumentExtractionProvider {
  if (instance) return instance;
  const env = getEnv();
  instance =
    env.PRODUCT_EXTRACTION_PROVIDER === "anthropic"
      ? new AnthropicExtractionProvider(env.ANTHROPIC_API_KEY, env.PRODUCT_EXTRACTION_MODEL)
      : new UnconfiguredExtractionProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setProductExtractionProviderForTesting(provider: ProductDocumentExtractionProvider | undefined): void {
  instance = provider;
}
