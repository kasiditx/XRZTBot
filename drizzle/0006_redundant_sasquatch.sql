ALTER TABLE "guild_settings" ADD COLUMN "stock_panel_message_id" text;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "public_message_id" text;--> statement-breakpoint
ALTER TABLE "withdrawal_fulfillments" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
UPDATE "withdrawal_fulfillments" SET "client_request_id" = 'legacy:' || "id"::text;--> statement-breakpoint
UPDATE "withdrawal_requests" SET "client_request_id" = 'legacy:' || "id"::text;--> statement-breakpoint
ALTER TABLE "withdrawal_fulfillments" ALTER COLUMN "client_request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ALTER COLUMN "client_request_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_fulfillments_guild_client_request_uq" ON "withdrawal_fulfillments" USING btree ("guild_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_requests_guild_client_request_uq" ON "withdrawal_requests" USING btree ("guild_id","client_request_id");
