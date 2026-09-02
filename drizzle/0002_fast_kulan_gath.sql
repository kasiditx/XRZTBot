ALTER TYPE "public"."attendance_result" ADD VALUE 'PENDING' BEFORE 'PRESENT';--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "request_id" text;--> statement-breakpoint
UPDATE "attendance_rounds" SET "request_id" = 'legacy:' || "id"::text WHERE "request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "emergency_leave_cutoff" timestamp with time zone;--> statement-breakpoint
UPDATE "attendance_rounds" SET "emergency_leave_cutoff" = "closes_at" WHERE "emergency_leave_cutoff" IS NULL;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ALTER COLUMN "emergency_leave_cutoff" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "announcement_channel_id" text;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD COLUMN "request_id" text;--> statement-breakpoint
UPDATE "attendance_schedules" SET "request_id" = 'legacy:' || "id"::text WHERE "request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "leave_panel_message_id" text;--> statement-breakpoint
ALTER TABLE "leaves" ADD COLUMN "request_id" text;--> statement-breakpoint
UPDATE "leaves" SET "request_id" = 'legacy:' || "id"::text WHERE "request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "leaves" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leaves" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_rounds_guild_request_uq" ON "attendance_rounds" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_schedules_guild_request_uq" ON "attendance_schedules" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leaves_guild_request_uq" ON "leaves" USING btree ("guild_id","request_id");
