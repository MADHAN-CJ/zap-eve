ALTER TABLE "broker_connections" ADD COLUMN "credential_fp" text;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "renew_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "last_renew_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "last_renewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "renew_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broker_connections" ADD COLUMN "last_renew_error" text;