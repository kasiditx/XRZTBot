ALTER TABLE "withdrawal_requests" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "decided_by_discord_user_id" text;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "rejection_reason" text;