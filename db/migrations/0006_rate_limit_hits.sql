CREATE TABLE "rate_limit_hits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("key","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_hits_window_idx" ON "rate_limit_hits" ("window_start");
