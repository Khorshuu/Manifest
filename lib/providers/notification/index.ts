import { getEnv } from "@/lib/env";
import { MockNotificationProvider } from "./mock";
import { SmtpNotificationProvider } from "./smtp";
import type { NotificationProvider } from "./types";

export * from "./types";
export { MockNotificationProvider, SmtpNotificationProvider };

let instance: NotificationProvider | undefined;

/**
 * The provider selected by NOTIFICATION_PROVIDER (DECISIONS.md D-004, D-132):
 * `mock`, which delivers nowhere and says so, or `smtp`, real email through
 * whichever service the SMTP settings name. No call site knows which.
 */
export function getNotificationProvider(): NotificationProvider {
  if (instance) return instance;

  instance =
    getEnv().NOTIFICATION_PROVIDER === "smtp" ? new SmtpNotificationProvider() : new MockNotificationProvider();
  return instance;
}

/** Test helper: replace the provider for the duration of a test. */
export function setNotificationProviderForTesting(
  provider: NotificationProvider | undefined,
): void {
  instance = provider;
}
