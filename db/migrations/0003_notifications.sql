CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid REFERENCES "orders"("id"),
	"user_id" uuid REFERENCES "users"("id"),
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_channel_check" CHECK ("channel" in ('email', 'sms')),
	CONSTRAINT "notifications_status_check" CHECK ("status" in ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "notifications_status_created_idx" ON "notifications" ("status","created_at");
--> statement-breakpoint
CREATE INDEX "notifications_order_idx" ON "notifications" ("order_id");
