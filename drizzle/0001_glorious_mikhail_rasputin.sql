DROP INDEX "threads_user_position_uidx";--> statement-breakpoint
CREATE INDEX "threads_user_position_idx" ON "threads" USING btree ("user_id","security_id","exchange_segment","product_type");