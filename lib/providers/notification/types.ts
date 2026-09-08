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
};

export type DeliveryResult = {
  /** The provider's own id, kept so a delivery can be traced later. */
  providerMessageId: string;
};

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export interface NotificationProvider {
  send(message: OutgoingNotification): Promise<DeliveryResult>;
}
