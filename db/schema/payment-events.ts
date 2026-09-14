import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Provider webhook events, recorded before they are acted on (migration 0023).
 * Unique per (provider, event_id): a repeated delivery changes nothing.
 */
export const PAYMENT_EVENT_STATUSES = [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
] as const;
export type PaymentEventStatus = (typeof PAYMENT_EVENT_STATUSES)[number];

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    providerRef: text("provider_ref"),
    amountBdt: integer("amount_bdt"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    /** For staff; never shown to a customer. */
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "payment_events_status_check",
      sql`${table.status} in ('received', 'processing', 'processed', 'ignored', 'failed')`,
    ),
    uniqueIndex("payment_events_provider_event_unique").on(table.provider, table.eventId),
    index("payment_events_provider_ref_idx").on(table.providerRef),
  ],
);
