ALTER TABLE "audit_logs" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "public_message_id" text;--> statement-breakpoint
INSERT INTO "scheduled_jobs" (
  "guild_id",
  "job_type",
  "deduplication_key",
  "payload",
  "run_at"
)
SELECT
  "guild_id",
  'AUDIT_PUBLISH',
  'audit:' || "id"::text || ':publish',
  jsonb_build_object('auditId', "id"::text),
  "created_at"
FROM "audit_logs"
ON CONFLICT ("guild_id", "deduplication_key") DO NOTHING;
