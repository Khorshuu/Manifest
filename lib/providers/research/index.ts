import { getEnv } from "@/lib/env";
import { BraveResearchProvider } from "./brave";
import type { ProductResearchProvider } from "./types";
import { UnconfiguredResearchProvider } from "./unconfigured";

export * from "./types";
export { BraveResearchProvider, UnconfiguredResearchProvider };

let instance: ProductResearchProvider | undefined;

/**
 * The provider selected by PRODUCT_RESEARCH_PROVIDER.
 *
 * `none` is the default and a supported setting: the pipeline finds sources in
 * the Brand Source Registry, in the pages staff attach and in the documents
 * they provide, and reports NOT_CONFIGURED for the automatic part rather than
 * pretending to have searched (A-6).
 *
 * `brave` adds automatic discovery through one credentialed JSON API. It is
 * optional, it discovers addresses only, and everything it offers is still
 * retrieved, checked and reviewed the same way a staff-supplied address is.
 */
export function getProductResearchProvider(): ProductResearchProvider {
  if (instance) return instance;
  const env = getEnv();
  switch (env.PRODUCT_RESEARCH_PROVIDER) {
    case "brave":
      instance = new BraveResearchProvider(env.BRAVE_SEARCH_API_KEY);
      break;
    case "none":
      instance = new UnconfiguredResearchProvider();
      break;
  }
  return instance!;
}

/** Test helper: replace the provider for the duration of a test. */
export function setProductResearchProviderForTesting(provider: ProductResearchProvider | undefined): void {
  instance = provider;
}
