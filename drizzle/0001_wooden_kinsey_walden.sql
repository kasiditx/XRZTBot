ALTER TABLE "activities" ADD COLUMN "request_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "announcement_channel_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "leaderboard_channel_id" text;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD COLUMN "request_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD COLUMN "log_channel_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_guild_request_uq" ON "activities" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_submissions_guild_request_uq" ON "activity_submissions" USING btree ("guild_id","request_id");