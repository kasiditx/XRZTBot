ALTER TABLE "guild_settings" ADD COLUMN "member_roster_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "member_roster_message_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "withdrawal_log_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "deposit_log_channel_id" text;--> statement-breakpoint
UPDATE "guild_settings"
SET
  "withdrawal_log_channel_id" = "stock_channel_id",
  "deposit_log_channel_id" = "stock_channel_id"
WHERE "stock_channel_id" IS NOT NULL;
