ALTER TABLE "guild_settings" ADD COLUMN "registration_request_channel_id" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "registration_request_channel_id" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "registration_request_message_id" text;