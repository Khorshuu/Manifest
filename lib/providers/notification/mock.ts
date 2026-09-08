import { randomUUID } from "node:crypto";
import {
  DeliveryError,
  type DeliveryResult,
  type NotificationProvider,
  type OutgoingNotification,
} from "./types";

/**
 * The development provider. It delivers nowhere and says so.
 *
 * Nothing here pretends a message reached a person: the outbox row records
 * that delivery was attempted through the mock, and the admin outbox screen
 * says as much on the page, so no one reads a sent row as proof a customer
 * was told (CLAUDE.md section 6).
 */
export class MockNotificationProvider implements NotificationProvider {
  readonly sent: OutgoingNotification[] = [];

  async send(message: OutgoingNotification): Promise<DeliveryResult> {
    if (!message.recipient.trim()) {
      throw new DeliveryError("No recipient to deliver to.");
    }

    this.sent.push(message);

    return { providerMessageId: `mock_${randomUUID()}` };
  }
}
