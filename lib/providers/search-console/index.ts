import { z } from "zod";
import { GoogleSearchConsoleProvider } from "./google";
import type { SearchConsoleProvider } from "./types";
import { UnconfiguredSearchConsoleProvider } from "./unconfigured";

export * from "./types";
export { UnconfiguredSearchConsoleProvider, GoogleSearchConsoleProvider };

const schema = z.object({
  SEARCH_CONSOLE_PROVIDER: z.enum(["none", "google"]).default("none"),
});

let instance: SearchConsoleProvider | undefined;

/**
 * The provider named by SEARCH_CONSOLE_PROVIDER. "none" is a supported
 * setting, not a degraded one: the whole platform works without Search
 * Console, and every screen that shows its figures says so instead.
 */
export function getSearchConsoleProvider(): SearchConsoleProvider {
  if (instance) return instance;
  const parsed = schema.safeParse({ SEARCH_CONSOLE_PROVIDER: process.env.SEARCH_CONSOLE_PROVIDER?.trim() || undefined });
  if (!parsed.success) {
    throw new Error('SEARCH_CONSOLE_PROVIDER must be "none" or "google".');
  }
  instance =
    parsed.data.SEARCH_CONSOLE_PROVIDER === "google"
      ? new GoogleSearchConsoleProvider()
      : new UnconfiguredSearchConsoleProvider();
  return instance;
}

/** Test helper: replace the provider, and the fixture at the boundary with it. */
export function setSearchConsoleProviderForTesting(provider: SearchConsoleProvider | undefined): void {
  instance = provider;
}
