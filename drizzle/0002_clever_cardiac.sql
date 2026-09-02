CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"security_id" text NOT NULL,
	"exchange_segment" text NOT NULL,
	"symbol" text NOT NULL,
	"interval" text NOT NULL,
	"instruction" text NOT NULL,
	"kind" text DEFAULT 'levels' NOT NULL,
	"conditions" jsonb,
	"mode" text DEFAULT 'any' NOT NULL,
	"check_interval_minutes" integer,
	"last_verdict" text,
	"status" text DEFAULT 'ARMED' NOT NULL,
	"last_values" jsonb,
	"latched" jsonb,
	"last_checked_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"last_alert_at" timestamp with time zone,
	"firing_at" timestamp with time zone,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watches_status_idx" ON "watches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "watches_thread_idx" ON "watches" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "watches_user_armed_idx" ON "watches" USING btree ("user_id") WHERE "watches"."status" = 'ARMED';