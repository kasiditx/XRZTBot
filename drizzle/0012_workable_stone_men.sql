ALTER TABLE "guild_settings" ADD COLUMN "leave_log_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "fine_log_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "weekly_dues_log_channel_id" text;--> statement-breakpoint
UPDATE "guild_settings"
SET
	"leave_log_channel_id" = "leave_channel_id",
	"fine_log_channel_id" = "fine_channel_id",
	"weekly_dues_log_channel_id" = "weekly_dues_channel_id";
