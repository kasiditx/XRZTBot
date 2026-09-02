CREATE TYPE "public"."activity_mode" AS ENUM('SCORE', 'EVIDENCE', 'ANNOUNCEMENT');--> statement-breakpoint
ALTER TABLE "activity_submissions" ALTER COLUMN "score_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "mode" "activity_mode" DEFAULT 'SCORE' NOT NULL;