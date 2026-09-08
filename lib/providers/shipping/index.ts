import { getEnv } from "@/lib/env";
import { MockShippingProvider } from "./mock";
import type { ShippingProvider } from "./types";

export * from "./types";
export { MockShippingProvider };

let instance: ShippingProvider | undefined;

/**
 * The provider selected by SHIPPING_PROVIDER. Only the mock exists today; a
 * courier integration slots in here without any call site changing.
 */
export function getShippingProvider(): ShippingProvider {
  if (instance) return instance;

  if (getEnv().SHIPPING_PROVIDER === "courier") {
    throw new Error(
      "No courier provider is implemented yet. Set SHIPPING_PROVIDER=mock.",
    );
  }

  instance = new MockShippingProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setShippingProviderForTesting(
  provider: ShippingProvider | undefined,
): void {
  instance = provider;
}
