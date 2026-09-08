import { getEnv } from "@/lib/env";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./types";

export * from "./types";
export { MockPaymentProvider };

let instance: PaymentProvider | undefined;

/**
 * The provider selected by PAYMENT_PROVIDER. Only the mock exists today;
 * SSLCommerz slots in here without any call site changing (DECISIONS.md D-004).
 */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;

  const configured = getEnv().PAYMENT_PROVIDER;

  if (configured === "sslcommerz") {
    throw new Error(
      "The SSLCommerz provider is not implemented yet. Set PAYMENT_PROVIDER=mock.",
    );
  }

  instance = new MockPaymentProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setPaymentProviderForTesting(
  provider: PaymentProvider | undefined,
): void {
  instance = provider;
}
