import { getEnv } from "@/lib/env";
import { AnthropicExtractionProvider } from "./anthropic";
import { OllamaExtractionProvider } from "./ollama";
import type { ProductDocumentExtractionProvider } from "./types";
import { UnconfiguredExtractionProvider } from "./unconfigured";

export * from "./types";
export { AnthropicExtractionProvider, OllamaExtractionProvider, UnconfiguredExtractionProvider };

let instance: ProductDocumentExtractionProvider | undefined;

/**
 * The provider selected by PRODUCT_EXTRACTION_PROVIDER (D-123).
 *
 * `none` is the default and fully supported: every document is read by the
 * deterministic extractors and nothing else. `anthropic` adds source-grounded
 * reading of prose for documents those extractors could not use; it needs
 * ANTHROPIC_API_KEY, and without it reports UNAVAILABLE rather than failing
 * the research run. `ollama` does the same reading with a model running on
 * this computer (D-124): no key, no per-document charge, and no fallback to a
 * hosted service when Ollama is not running.
 */
export function getProductExtractionProvider(): ProductDocumentExtractionProvider {
  if (instance) return instance;
  const env = getEnv();
  switch (env.PRODUCT_EXTRACTION_PROVIDER) {
    case "anthropic":
      instance = new AnthropicExtractionProvider(env.ANTHROPIC_API_KEY, env.PRODUCT_EXTRACTION_MODEL);
      break;
    case "ollama":
      instance = OllamaExtractionProvider.fromConfig();
      break;
    case "none":
      instance = new UnconfiguredExtractionProvider();
      break;
  }
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setProductExtractionProviderForTesting(provider: ProductDocumentExtractionProvider | undefined): void {
  instance = provider;
}
