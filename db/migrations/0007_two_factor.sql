ALTER TABLE "users" ADD COLUMN "totp_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_used_step" integer;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pending_two_factor" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" ("user_id");
