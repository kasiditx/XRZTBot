ALTER TABLE "attendance_rounds" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "cancelled_by_discord_user_id" text;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD CONSTRAINT "attendance_rounds_cancellation_complete" CHECK ((
      "attendance_rounds"."status" <> 'CANCELLED'
      AND "attendance_rounds"."cancelled_at" IS NULL
      AND "attendance_rounds"."cancelled_by_discord_user_id" IS NULL
      AND "attendance_rounds"."cancellation_reason" IS NULL
    ) OR (
      "attendance_rounds"."status" = 'CANCELLED'
      AND "attendance_rounds"."cancelled_at" IS NOT NULL
      AND "attendance_rounds"."cancelled_by_discord_user_id" IS NOT NULL
      AND length(trim("attendance_rounds"."cancellation_reason")) > 0
    ));