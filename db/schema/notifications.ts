import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { orders } from "./orders";
import { users } from "./users";

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ["queued", "sent", "failed"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * The outbox.
 *
 * A message is written here inside the same transaction as the change that
 * caused it, then delivered separately. That ordering is what makes the two
 * failure modes survivable: a crash before delivery leaves a queued row to
 * retry, and a crash after the business change still leaves the message
 * recorded rather than lost.
 *
 * `dedupe_key` is the idempotency guarantee CLAUDE.md section 7 asks for on
 * order events. A replayed payment webhook writes the same key, the unique
 * constraint refuses it, and the customer is not told twice.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").references(() => orders.id),
    userId: uuid("user_id").references(() => users.id),
    /** The address or number as it was at send time, not a live lookup. */
    recipient: text("recipient").notNull(),
    channel: text("channel").notNull(),
    /** Which message this is, e.g. order.payment_confirmed. */
    template: text("template").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("queued"),
    dedupeKey: text("dedupe_key").notNull(),
    providerMessageId: text("provider_message_id"),
    /** Why delivery failed, for staff. Never shown to the customer. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    unique("notifications_dedupe_key_unique").on(table.dedupeKey),
    check(
      "notifications_channel_check",
      sql`${table.channel} in ('email', 'sms')`,
    ),
    check(
      "notifications_status_check",
      sql`${table.status} in ('queued', 'sent', 'failed')`,
    ),
    index("notifications_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("notifications_order_idx").on(table.orderId),
  ],
);
