ALTER TYPE "public"."attendance_mode" ADD VALUE 'LOOP';--> statement-breakpoint
ALTER TABLE "attendance_schedules" DROP CONSTRAINT "attendance_schedules_mode_fields";--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_mode_fields" CHECK ((
      "attendance_schedules"."mode" <> 'AIRDROP'
      AND "attendance_schedules"."opens_at_local_time" IS NOT NULL
      AND "attendance_schedules"."closes_at_local_time" IS NOT NULL
      AND "attendance_schedules"."event_at_local_time" IS NULL
      AND "attendance_schedules"."opens_before_minutes" IS NULL
      AND "attendance_schedules"."closes_after_minutes" IS NULL
    ) OR (
      "attendance_schedules"."mode" = 'AIRDROP'
      AND "attendance_schedules"."opens_at_local_time" IS NULL
      AND "attendance_schedules"."closes_at_local_time" IS NULL
      AND "attendance_schedules"."event_at_local_time" IS NOT NULL
      AND "attendance_schedules"."opens_before_minutes" BETWEEN 0 AND 1440
      AND "attendance_schedules"."closes_after_minutes" BETWEEN 0 AND 1440
      AND ("attendance_schedules"."opens_before_minutes" + "attendance_schedules"."closes_after_minutes") > 0
    ));