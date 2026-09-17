import { getEnv } from "@/lib/env";
import type { ProductResearchProvider } from "./types";
import { UnconfiguredResearchProvider } from "./unconfigured";

export * from "./types";
export { UnconfiguredResearchProvider };

let instance: ProductResearchProvider | undefined;

/**
 * The provider selected by PRODUCT_RESEARCH_PROVIDER. Only the unconfigured
 * one exists today; a search or catalogue API slots in here without any call
 * site changing, and nothing in the pipeline requires one.
 */
export function getProductResearchProvider(): ProductResearchProvider {
  if (instance) return instance;
  const configured = getEnv().PRODUCT_RESEARCH_PROVIDER;
  if (configured !== "none") {
    throw new Error(`No product research provider named "${configured}" is implemented. Set PRODUCT_RESEARCH_PROVIDER=none.`);
  }
  instance = new UnconfiguredResearchProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setProductResearchProviderForTesting(provider: ProductResearchProvider | undefined): void {
  instance = provider;
}
