CREATE TYPE "public"."attendance_mode" AS ENUM('AIRDROP', 'GENERAL');--> statement-breakpoint
ALTER TABLE "attendance_schedules" ALTER COLUMN "opens_at_local_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ALTER COLUMN "closes_at_local_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "proof_attachment_id" text;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "proof_channel_id" text;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "proof_message_id" text;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "proof_sha256" text;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "mode" "attendance_mode" DEFAULT 'GENERAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD COLUMN "event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD COLUMN "mode" "attendance_mode" DEFAULT 'GENERAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD COLUMN "event_at_local_time" text;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD COLUMN "opens_before_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD COLUMN "closes_after_minutes" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_proof_sha256_uq" ON "attendance_records" USING btree ("proof_sha256") WHERE "attendance_records"."proof_sha256" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_proof_sha256_format" CHECK ("attendance_records"."proof_sha256" IS NULL OR length("attendance_records"."proof_sha256") = 64);--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_proof_fields_complete" CHECK ((
      "attendance_records"."proof_attachment_id" IS NULL
      AND "attendance_records"."proof_channel_id" IS NULL
      AND "attendance_records"."proof_message_id" IS NULL
      AND "attendance_records"."proof_sha256" IS NULL
    ) OR (
      "attendance_records"."proof_attachment_id" IS NOT NULL
      AND "attendance_records"."proof_channel_id" IS NOT NULL
      AND "attendance_records"."proof_message_id" IS NOT NULL
      AND "attendance_records"."proof_sha256" IS NOT NULL
    ));--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD CONSTRAINT "attendance_rounds_airdrop_event" CHECK ("attendance_rounds"."mode" <> 'AIRDROP' OR "attendance_rounds"."event_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD CONSTRAINT "attendance_rounds_event_in_window" CHECK ("attendance_rounds"."event_at" IS NULL OR ("attendance_rounds"."event_at" >= "attendance_rounds"."opens_at" AND "attendance_rounds"."event_at" <= "attendance_rounds"."closes_at"));--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_mode_fields" CHECK ((
      "attendance_schedules"."mode" = 'GENERAL'
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