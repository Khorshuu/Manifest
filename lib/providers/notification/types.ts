/**
 * Notification delivery.
 *
 * Deliberately narrow: the caller decides what to say and to whom, and the
 * provider only carries it. Composing the message is business logic and lives
 * in lib/notifications, so an email provider and an SMS provider stay
 * interchangeable (docs/ARCHITECTURE.md).
 */

export type NotificationChannel = "email" | "sms";

export type OutgoingNotification = {
  channel: NotificationChannel;
  /** An email address or a phone number, already decided by the caller. */
  recipient: string;
  subject: string;
  body: string;
  /**
   * The same for every attempt at one message (the outbox row's id). A
   * provider that can refuse a repeat uses it; one that cannot still carries
   * it, so a duplicate can be recognised afterwards (D-132).
   */
  idempotencyKey?: string;
};

export type DeliveryResult = {
  /** The provider's own id, kept so a delivery can be traced later. */
  providerMessageId: string;
};

export class DeliveryError extends Error {
  /**
   * True when trying again cannot help: an address that is not an address, a
   * channel this provider does not carry, a recipient this environment may
   * not write to. The outbox stops at once instead of spending its retries.
   */
  readonly permanent: boolean;

  constructor(message: string, options: { permanent?: boolean } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.permanent = options.permanent === true;
  }
}

/**
 * Whether the provider could deliver right now, for operators. A state and a
 * sentence only: never a host, a user name or a credential.
 */
export type NotificationProviderHealth = {
  provider: string;
  state: "mock" | "ready" | "not_configured" | "unavailable";
  message: string;
};

export interface NotificationProvider {
  /** Which provider this is: "mock", "smtp". */
  readonly name?: string;
  send(message: OutgoingNotification): Promise<DeliveryResult>;
  /** Optional: a bounded check that sends nothing. */
  health?(): Promise<NotificationProviderHealth>;
}
