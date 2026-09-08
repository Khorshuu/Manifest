import { getEnv } from "@/lib/env";
import { MockNotificationProvider } from "./mock";
import type { NotificationProvider } from "./types";

export * from "./types";
export { MockNotificationProvider };

let instance: NotificationProvider | undefined;

/**
 * The provider selected by NOTIFICATION_PROVIDER. Only the mock exists today;
 * a real email/SMS provider slots in here without any call site changing
 * (DECISIONS.md D-004).
 */
export function getNotificationProvider(): NotificationProvider {
  if (instance) return instance;

  if (getEnv().NOTIFICATION_PROVIDER === "live") {
    throw new Error(
      "No live notification provider is implemented yet. Set NOTIFICATION_PROVIDER=mock.",
    );
  }

  instance = new MockNotificationProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setNotificationProviderForTesting(
  provider: NotificationProvider | undefined,
): void {
  instance = provider;
}
