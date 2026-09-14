CREATE TYPE "public"."bot_operational_status" AS ENUM('OPERATIONAL', 'UPDATING');--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status_message_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status" "bot_operational_status" DEFAULT 'OPERATIONAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status_detail" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "bot_status_updated_by_discord_user_id" text;